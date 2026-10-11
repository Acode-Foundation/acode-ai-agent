import type { Context, JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { CodemodeSourceError, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineTool,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatOutput,
  joinAdjacentText,
  truncateOutput,
  valueText,
  type OutputBlock,
} from "./output";
import { loadCodemodeRuntime } from "./runtime";
import { CodemodeSandbox, type CodemodeResult, type CodemodeRuntime } from "./sandbox";

export const CODEMODE_TOOL_NAME = "codemode";

/** Tools scripts never reach: no nested scripts or delegation, and no questions to the user. */
const NOT_CALLABLE = new Set([CODEMODE_TOOL_NAME, "subagent", "ask_user_question"]);

/**
 * Heap limit for one script's VM. The worker shares the app's memory on a phone, so a runaway
 * script fails with `InternalError: out of memory` instead of growing until Android kills Acode.
 */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

const ARG_VALUE_CHARS = 160;
/** Nested calls kept in the details; a script that loops over many calls only counts the rest. */
const MAX_RECORDED_CALLS = 200;
/** Text arguments the work log shows as a size, never as content. */
const BULK_ARGS = new Set(["content", "new_string", "old_string", "newText", "oldText"]);
const ERROR_PREVIEW_CHARS = 300;

/**
 * Values scripts keep with `store()`/`load()`, stored with the conversation so they survive
 * restarts and a fork starts with its parent's values.
 */
export const CodemodeStoreDoc = defineDoc<{ values: { [key: string]: JsonValue } }>({
  kind: "acode.codemode.store",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ values: {} }),
});

/** One nested call as the work log and the error summary show it. */
export type CodemodeCallRecord = {
  name: string;
  /** Scalar arguments only, shortened; file contents become their size. */
  args: { [key: string]: string | number | boolean };
  /** `waiting`: the user is being asked to approve this call. */
  status: "running" | "waiting" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
};

export type CodemodeDetails = {
  calls: CodemodeCallRecord[];
  /** Calls made after `MAX_RECORDED_CALLS`, counted but not listed. */
  omitted?: number;
};

export type CodemodeToolOptions = {
  /** Tools scripts may call. A call also needs the tool to be active in the calling conversation. */
  tools: readonly ToolRegistration[];
  /**
   * Approve a nested call the way the harness approves a direct one. Returns the reason when the
   * call is blocked. `onPrompt` runs when the user is actually asked.
   */
  approve(
    name: string,
    args: Record<string, unknown>,
    api: ToolExecutionApi,
    signal: AbortSignal,
    onPrompt: () => void,
  ): Promise<string | undefined>;
  /** Defaults to the worker and QuickJS module shipped with the plugin. */
  runtime?: () => Promise<CodemodeRuntime>;
};

/**
 * The `codemode` tool: the model writes JavaScript that calls other tools as
 * `await tools.<name>(args)`. Only the script's output reaches the model, so a script can run
 * independent calls together, chain them, and filter large results first. Nested calls are
 * validated and approved like direct calls; their edits are recorded for Undo because they
 * commit through the codemode call. Calls made before a failure are not undone.
 */
export function createCodemodeTool(options: CodemodeToolOptions): ToolRegistration {
  const callable = options.tools.filter((tool) => !NOT_CALLABLE.has(tool.name));
  return defineTool({
    name: CODEMODE_TOOL_NAME,
    description: codemodeDescription(callable),
    parameters: Type.Object({
      code: Type.String({
        description:
          "Raw JavaScript source (not JSON, no code fence), run as an async function body.",
      }),
    }),
    // Nested calls may change files; keep the round in order.
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const startedAt = performance.now();
      let parsed;
      try {
        parsed = parseCodemodeSource(args.code);
      } catch (error) {
        if (error instanceof CodemodeSourceError) throw new Error(error.message);
        throw error;
      }
      const active = new Set((await api.agent(context)).tools.map((tool) => tool.name));
      const tools = callable.filter((tool) => active.has(tool.name));
      const details: CodemodeDetails = { calls: [] };
      // Coalesce progress: a script can start many calls at once.
      let publishTimer: ReturnType<typeof setTimeout> | undefined;
      const publish = () => {
        publishTimer ??= setTimeout(() => {
          publishTimer = undefined;
          api.details(structuredClone(details) as unknown as JsonValue, context).catch(() => {});
        }, 120);
      };

      const sandbox = new CodemodeSandbox({
        tools: tools.map((tool) =>
          nestedTool(tool, api, context, options, (record) => {
            if (details.calls.length < MAX_RECORDED_CALLS) details.calls.push(record);
            else details.omitted = (details.omitted ?? 0) + 1;
            api.output(`→ ${record.name}${callTarget(record.args)}\n`);
            publish();
            return {
              changed: () => {
                if (record.status === "waiting")
                  api.output(`… ${record.name} is waiting for approval\n`);
                publish();
              },
              done: () => {
                const mark = record.status === "ok" ? "✓" : "✗";
                api.output(`${mark} ${record.name}${record.error ? `: ${record.error}` : ""}\n`);
                publish();
              },
            };
          }),
        ),
        globals: discoveryGlobals(tools),
        timeoutMs: parsed.options.timeoutMs ?? Number.POSITIVE_INFINITY,
        memoryLimitBytes: MEMORY_LIMIT_BYTES,
        runtime: options.runtime ?? loadCodemodeRuntime,
      });

      let result: CodemodeResult;
      try {
        const store = await api.commit(
          async (tx) =>
            structuredClone((await tx.doc(CodemodeStoreDoc, api.conversationId)).values),
          context,
        );
        result = await sandbox.execute(parsed.code, { signal: context.abortSignal, store });
      } finally {
        clearTimeout(publishTimer);
        await sandbox.close();
      }
      for (const call of details.calls)
        if (call.status === "running" || call.status === "waiting") call.status = "cancelled";

      const scriptOutput = [...result.output];
      if (result.ok) {
        const { set, delete: deleted } = result.storeWrites;
        if (Object.keys(set).length || deleted.length)
          await api.commit(async (tx) => {
            const doc = await tx.doc(CodemodeStoreDoc, api.conversationId);
            for (const key of deleted) delete doc.values[key];
            for (const [key, value] of Object.entries(set)) doc.values[key] = value as JsonValue;
          }, context);
        if (result.value !== undefined)
          scriptOutput.push({ type: "text", text: valueText(result.value) });
      }
      const items: OutputBlock[] = formatOutput(scriptOutput);
      if (!result.ok)
        items.push({ type: "text", text: `Script error:\n${formatError(result, details.calls)}` });
      const output = truncateOutput(
        joinAdjacentText(items),
        parsed.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      );
      const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
      const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
      return {
        content: joinAdjacentText([{ type: "text", text: header }, ...output]),
        details: details as unknown as JsonValue,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  });
}

/**
 * A tool as scripts call it: arguments are repaired and validated against the tool's schema,
 * approved, and run with the codemode call's API, so the nested call commits, records edits,
 * and stops with the script. The script receives the text output; failures reject.
 */
function nestedTool(
  tool: ToolRegistration,
  api: ToolExecutionApi,
  context: Context,
  options: CodemodeToolOptions,
  track: (record: CodemodeCallRecord) => { changed(): void; done(): void },
): CodemodeTool {
  return {
    name: tool.name,
    description: tool.description,
    execute: async (raw, { signal }) => {
      const record: CodemodeCallRecord = {
        name: tool.name,
        args: summarizeArgs(raw),
        status: "running",
      };
      const progress = track(record);
      const started = performance.now();
      const waiting = (value: boolean) => {
        record.status = value ? "waiting" : "running";
        progress.changed();
      };
      try {
        const value = await runNested(tool, raw, api, context, options, signal, waiting);
        record.status = "ok";
        return value;
      } catch (error) {
        record.status = signal.aborted ? "cancelled" : "error";
        record.error = preview(
          error instanceof Error ? error.message : String(error),
          ERROR_PREVIEW_CHARS,
        );
        throw error;
      } finally {
        record.durationMs = Math.round(performance.now() - started);
        progress.done();
      }
    },
  };
}

async function runNested(
  tool: ToolRegistration,
  raw: unknown,
  api: ToolExecutionApi,
  context: Context,
  options: CodemodeToolOptions,
  signal: AbortSignal,
  waiting: (value: boolean) => void,
): Promise<string> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(raw ?? {}) : (raw ?? {});
  const args = validateToolArguments(tool, {
    type: "toolCall",
    id: api.callId,
    name: tool.name,
    arguments: prepared as Record<string, JsonValue>,
  }) as Record<string, unknown>;
  let prompted = false;
  const blocked = await options.approve(tool.name, args, api, signal, () => {
    prompted = true;
    waiting(true);
  });
  if (prompted && !blocked) waiting(false);
  if (blocked) throw new Error(blocked);
  if (signal.aborted) throw new Error("The script ended before this call ran.");

  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const diagnostics: ToolDiagnostic[] = [];
  const nestedApi: ToolExecutionApi = {
    ...api,
    output: (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
    // The nested tool keeps the head of its output; skips would bypass the collection above.
    outputWindow: undefined,
    diagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    // Running details belong to the codemode call.
    details: async () => {},
  };
  const result = await tool.execute(args, nestedApi, withAbortSignal(signal, context));
  const text = result.content
    ? result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    : chunks.join("");
  const failure = [...diagnostics, ...(result.diagnostics ?? [])].find(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (result.isError || failure)
    throw new Error(failure?.message || text || `Tool "${tool.name}" failed`);
  return text;
}

/** `searchTools(query, { limit })` and `describeTool(name)` over the tools a script can call. */
function discoveryGlobals(tools: readonly ToolRegistration[]): CodemodeTool[] {
  const find = (name: string) =>
    tools.find((tool) => tool.name === name || toCodemodeIdentifier(tool.name) === name);
  return [
    {
      name: "searchTools",
      spread: true,
      execute: (args) => {
        const [query, options] = args as [unknown, { limit?: unknown } | undefined];
        if (typeof query !== "string") throw new Error("searchTools() expects a query string");
        const limit = options?.limit ?? 5;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
          throw new Error("searchTools() limit must be a positive integer");
        const terms = query
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        return tools
          .map((tool) => {
            const name = tool.name.toLowerCase();
            const description = tool.description.toLowerCase();
            const score = terms.reduce(
              (total, term) =>
                total + (name.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0),
              0,
            );
            return { tool, score };
          })
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ tool }) => ({
            name: toCodemodeIdentifier(tool.name),
            description: tool.description,
          }));
      },
    },
    {
      name: "describeTool",
      spread: true,
      execute: (args) => {
        const [name] = args as [unknown];
        if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
        const tool = find(name);
        return tool
          ? renderToolSample({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as Record<string, unknown>,
              outputSchema: { type: "string" },
            })
          : undefined;
      },
    },
  ];
}

function codemodeDescription(tools: readonly ToolRegistration[]): string {
  const names = tools.map((tool) => {
    const id = toCodemodeIdentifier(tool.name);
    return id === tool.name ? id : `${id} (${tool.name})`;
  });
  return [
    "Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async " +
      "function body in a QuickJS sandbox: top-level `await` and `return` work. No DOM, file system, network, or timers.",
    "Use it to run independent calls together (`await Promise.allSettled([...])`), chain calls, or filter large " +
      "results before you read them, instead of many separate tool calls. Only the script's output reaches you.",
    "- `await tools.<name>({ ...args })` takes the same arguments as the declared tool and resolves to its text " +
      "output; it rejects with an Error on failure. Edits, deletes, and commands still need the user's approval. " +
      "Calls still running when the script ends are cancelled; calls made before a failure are not undone.",
    `- Callable: ${names.join(", ") || "none"}.`,
    "- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and `return value` add output; `exit()` ends " +
      "the script. `store(key, value)` / `load(key)` keep small JSON values across scripts in this chat. " +
      "`ALL_TOOLS` lists the callable tools; `await searchTools(query)` and `await describeTool(name)` look them up.",
    '- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`',
  ].join("\n");
}

function formatError(
  result: Extract<CodemodeResult, { ok: false }>,
  calls: readonly CodemodeCallRecord[],
): string {
  const { error } = result;
  const head =
    error.kind === "script"
      ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  const summary = calls.length
    ? `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`
    : "No tool calls were made.";
  return `${head}\n\n${summary}`;
}

function summarizeArgs(args: unknown): CodemodeCallRecord["args"] {
  const summary: CodemodeCallRecord["args"] = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return summary;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string")
      summary[key] = BULK_ARGS.has(key)
        ? `[${value.length} characters]`
        : preview(value, ARG_VALUE_CHARS);
    else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `[${value.length} items]`;
  }
  return summary;
}

/** The argument that says what a call works on, for the progress line. */
function callTarget(args: CodemodeCallRecord["args"]): string {
  for (const key of ["path", "pattern", "query", "command", "url", "source"]) {
    const value = args[key];
    if (typeof value === "string" && value) return ` ${preview(value.replace(/\s+/g, " "), 80)}`;
  }
  return "";
}

function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isCodemodeDetails(value: unknown): value is CodemodeDetails {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { calls?: unknown }).calls)
  );
}
