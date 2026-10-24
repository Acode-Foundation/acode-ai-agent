import type { JsonValue } from "@earendil-works/chord";
import { Type, type Message } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  defineDoc,
  defineTool,
  type ConversationId,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/** How the model reaches a tool: declared on every request, or loaded by `tool_search` when needed. */
export type ToolExposure = "direct" | "deferred";

/**
 * Built-in tools the model seldom needs, kept out of every request until loaded: about 900 tokens
 * on folders without `bash`, where the file operation tools exist.
 */
export const DEFERRED_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "move_path",
  "rename_path",
  "copy_path",
  "delete_path",
  "create_directory",
  "ask_user_question",
  "list_sessions",
  "read_session",
  "acode_guide",
  "acode_settings",
  "acode_update_settings",
  "acode_commands",
  "acode_run_command",
  "acode_plugins",
  "acode_ui",
]);

const DEFAULT_LIMIT = 5;

/**
 * The deferred tools this conversation has been set up for. A deferred tool missing from it is
 * new, so it starts hidden; one in it but not hidden was loaded by `tool_search`.
 */
const DeferredToolsDoc = defineDoc<{ known: string[] }>({
  kind: "acode.deferred-tools",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ known: [] }),
  checkpointWhen: () => false,
});

/**
 * Keep a conversation's tool filter in step with the deferred tools: new deferred tools are hidden,
 * tools that are no longer deferred are declared again, and tools `tool_search` loaded stay loaded.
 * Loading goes through the result's `control.addTools`, which edits the same filter, so it follows
 * the branch like any agent change. Conversations that offer an explicit list (subagents) keep it.
 *
 * With `inUse` (from `toolsInUse` over the model context), a loaded tool the context no longer
 * shows, neither called nor loaded, is hidden again: compaction summarized its use away, so it
 * would only cost tokens. The model can load it again.
 */
export async function syncDeferredTools(
  tx: Tx,
  conversationId: ConversationId,
  deferred: readonly string[],
  inUse?: ReadonlySet<string>,
): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId);
  if (Array.isArray(agent.tools)) return;
  const known = await tx.doc(DeferredToolsDoc, conversationId);
  const hidden = agent.tools?.remove ?? [];
  const wanted = new Set(deferred);
  const seen = new Set(known.known);
  const next = [
    ...hidden.filter((name) => wanted.has(name)),
    ...deferred.filter((name) => !seen.has(name) && !hidden.includes(name)),
    ...(inUse
      ? deferred.filter((name) => seen.has(name) && !hidden.includes(name) && !inUse.has(name))
      : []),
  ];
  if (!sameNames(hidden, next)) {
    if (next.length) agent.tools = { remove: next };
    else delete agent.tools;
  }
  if (!sameNames(known.known, deferred)) known.known = [...deferred];
}

/**
 * Tools the model context still shows in use: ones it called, and ones a `tool_search` result it
 * still holds loaded. Calls made inside codemode scripts do not count; scripts need no loading.
 */
export function toolsInUse(messages: readonly Message[]): Set<string> {
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") used.add(part.name);
    } else if (message.role === "toolResult" && message.toolName === TOOL_SEARCH_TOOL_NAME) {
      const loaded = (message.details as { loaded?: unknown } | undefined)?.loaded;
      if (Array.isArray(loaded)) {
        for (const name of loaded) if (typeof name === "string") used.add(name);
      } else {
        // Results without details: the text lists each loaded tool as "- name: summary".
        for (const part of message.content)
          if (part.type === "text")
            for (const match of part.text.matchAll(/^- ([\w-]+):/gm)) used.add(match[1]!);
      }
    }
  }
  return used;
}

/** Whether a conversation offers every tool except a hidden few, as user chats do; subagents list theirs. */
export async function offersAllTools(tx: Tx, conversationId: ConversationId): Promise<boolean> {
  return !Array.isArray((await tx.doc(AgentDoc, conversationId)).tools);
}

/**
 * `tool_search`: ranks the deferred tools this conversation has not loaded yet and loads the
 * matches for the next model call. The system prompt names the deferred tools; the description
 * stays fixed, so registering a tool never changes the declarations already cached.
 */
export function createToolSearchTool(deferred: readonly ToolRegistration[]): ToolRegistration {
  return defineTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description:
      "Load deferred tools (the system prompt names them) so you can call them from your next turn. " +
      "Pass tool names, or describe what you need (for example 'rename a file').",
    parameters: Type.Object({
      query: Type.String({ description: "Tool names, or what the tool should do" }),
      limit: Type.Optional(
        Type.Number({ description: `Maximum tools to load (default ${DEFAULT_LIMIT})` }),
      ),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, api, context) => {
      const query = args.query.trim();
      if (!query) throw new Error("query must not be empty");
      const limit = args.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0)
        throw new Error("limit must be a positive integer");
      const active = new Set((await api.agent(context)).tools.map((tool) => tool.name));
      const found = findTools(query, deferred, limit, active);
      const matches = found.filter((tool) => !active.has(tool.name));
      const loaded = matches.map((tool) => tool.name);
      const already = found.filter((tool) => active.has(tool.name)).map((tool) => tool.name);
      const candidates = deferred.filter((tool) => !active.has(tool.name));
      const lines = matches.map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`);
      const text = matches.length
        ? `Loaded ${matches.length} tool${matches.length === 1 ? "" : "s"}; call them from your next turn:\n${lines.join("\n")}`
        : already.length
          ? `Already loaded: ${already.join(", ")}.`
          : `No matching tools. Not loaded yet: ${candidates.map((tool) => tool.name).join(", ") || "none"}.`;
      return {
        output: [{ type: "text", text }],
        details: { loaded } as JsonValue,
        ...(loaded.length ? { control: { addTools: loaded } } : {}),
      };
    },
  });
}

/**
 * Exact tool names win, loaded or not; otherwise BM25 over names, descriptions, and parameter
 * text of the tools not in `loaded`.
 */
export function findTools(
  query: string,
  tools: readonly ToolRegistration[],
  limit: number,
  loaded: ReadonlySet<string> = new Set(),
): ToolRegistration[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const named = query
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => byName.get(part));
  if (named.length && named.every(Boolean))
    return [...new Set(named)].slice(0, limit) as ToolRegistration[];
  const ranked = rank(
    query,
    tools
      .filter((tool) => !loaded.has(tool.name))
      .map((tool) => ({ name: tool.name, text: searchText(tool) })),
  );
  return ranked.slice(0, limit).map((name) => byName.get(name)!);
}

const STOP_WORDS = new Set(
  "a an and are as at be by for from in is it of on or that the this to with".split(" "),
);

/** Naive singular form, so `files` matches `file` and `directories` matches `directory`. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term && !STOP_WORDS.has(term))
    .map(stem);
}

function searchText(tool: ToolRegistration): string {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  const visit = (schema: unknown) => {
    if (!schema || typeof schema !== "object") return;
    const { description, properties, items } = schema as Record<string, unknown>;
    if (typeof description === "string") parts.push(description);
    if (properties && typeof properties === "object")
      for (const [name, property] of Object.entries(properties)) {
        parts.push(name);
        visit(property);
      }
    visit(items);
  };
  visit(tool.parameters);
  return parts.join(" ");
}

/** Okapi BM25 (k1 1.2, b 0.75); ties keep tool order. Returns names scoring at least half the best. */
function rank(query: string, documents: { name: string; text: string }[]): string[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !documents.length) return [];
  const counts = documents.map((document) => {
    const map = new Map<string, number>();
    for (const term of tokenize(document.text)) map.set(term, (map.get(term) ?? 0) + 1);
    return map;
  });
  const lengths = counts.map((map) => [...map.values()].reduce((sum, count) => sum + count, 0));
  const average = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
  const idf = new Map(
    terms.map((term) => {
      const frequency = counts.filter((map) => map.has(term)).length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
    }),
  );
  return (
    documents
      .map((document, index) => {
        let score = 0;
        for (const term of terms) {
          const count = counts[index]!.get(term);
          if (!count) continue;
          const norm = 1.2 * (1 - 0.75 + (0.75 * lengths[index]!) / average);
          score += (idf.get(term) ?? 0) * ((count * 2.2) / (count + norm));
        }
        return { name: document.name, score };
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      // Every loaded tool is declared from then on, so weak matches are not worth their tokens.
      .filter((match, _index, matches) => match.score >= matches[0]!.score * 0.5)
      .map((match) => match.name)
  );
}

function firstSentence(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  const end = line.search(/\.\s/);
  return end > 0 ? line.slice(0, end + 1) : line;
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
