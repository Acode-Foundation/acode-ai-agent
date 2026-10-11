import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { createCodemodeTool } from "../src/codemode/createCodemodeTool";
import { MutationGate } from "../src/permissions/mutationGate";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";
import { formatOutput, truncateOutput } from "../src/codemode/output";
import type { MessagePortLike } from "../src/codemode/protocol";
import { CodemodeSandbox, type CodemodeRuntime, type WorkerLike } from "../src/codemode/sandbox";
import { runCodemodeWorker } from "../src/codemode/workerMain";
import { parseScriptResult, presentTool, scriptCalls } from "../src/ui/transcript";

const wasm = WebAssembly.compile(readFileSync("node_modules/quickjs-wasi/quickjs.wasm"));

type Listener = (event: { data: unknown }) => void;

/** The real worker code on an in-process channel. Messages are async, like postMessage. */
function inProcessRuntime(): () => Promise<CodemodeRuntime> {
  return async () => ({
    wasm: await wasm,
    createWorker: (): WorkerLike => {
      const toWorker = new Set<Listener>();
      const toHost = new Set<Listener>();
      let terminated = false;
      const deliver = (listeners: Set<Listener>, data: unknown) =>
        queueMicrotask(() => {
          if (!terminated) for (const listener of listeners) listener({ data });
        });
      const workerSide: MessagePortLike = {
        postMessage: (message) => deliver(toHost, message),
        addEventListener: (_type, listener) => toWorker.add(listener),
      };
      runCodemodeWorker(workerSide);
      return {
        postMessage: (message) => deliver(toWorker, message),
        addEventListener: (type: string, listener: Listener) => {
          if (type === "message") toHost.add(listener);
        },
        terminate: () => {
          terminated = true;
        },
      } as WorkerLike;
    },
  });
}

describe("CodemodeSandbox", () => {
  it("runs a script that calls tools and returns output", async () => {
    const sandbox = new CodemodeSandbox({
      runtime: inProcessRuntime(),
      tools: [
        { name: "add-one", execute: (args) => (args as { n: number }).n + 1 },
        {
          name: "fail",
          execute: () => {
            throw new Error("nope");
          },
        },
      ],
    });
    const result = await sandbox.execute(`
      const [a, b] = await Promise.all([tools.add_one({ n: 1 }), tools["add-one"]({ n: 10 })]);
      text("sum " + (a + b));
      console.log("debug", { a });
      try { await tools.fail({}); } catch (error) { text("caught " + error.message); }
      return { a, b };
    `);
    await sandbox.close();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ a: 2, b: 11 });
    expect(result.output).toEqual([
      { type: "text", text: "sum 13" },
      { type: "text", text: 'debug {"a":2}', console: true },
      { type: "text", text: "caught nope" },
    ]);
    expect(result.calls.map((call) => [call.name, call.status])).toEqual([
      ["add-one", "ok"],
      ["add-one", "ok"],
      ["fail", "error"],
    ]);
  });

  it("reports script errors with partial output", async () => {
    const sandbox = new CodemodeSandbox({ runtime: inProcessRuntime() });
    const result = await sandbox.execute(`text("before");\nnull.x;`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("script");
    expect(result.error.stack).toContain("codemode.js:2");
    expect(result.output).toEqual([{ type: "text", text: "before" }]);
  });

  it("fails a script that waits on nothing", async () => {
    const sandbox = new CodemodeSandbox({ runtime: inProcessRuntime() });
    const result = await sandbox.execute("await new Promise(() => {});");
    expect(result.ok).toBe(false);
  });

  it("times out and cancels pending tool calls", async () => {
    let cancelled = false;
    const sandbox = new CodemodeSandbox({
      runtime: inProcessRuntime(),
      timeoutMs: 50,
      tools: [
        {
          name: "wait",
          execute: (_args, { signal }) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => {
                cancelled = true;
                reject(new Error("aborted"));
              }),
            ),
        },
      ],
    });
    const result = await sandbox.execute("await tools.wait({});");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(cancelled).toBe(true);
    expect(result.calls[0]?.status).toBe("cancelled");
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const sandbox = new CodemodeSandbox({
      runtime: inProcessRuntime(),
      tools: [{ name: "wait", execute: () => new Promise(() => {}) }],
    });
    const pending = sandbox.execute("await tools.wait({});", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe("aborted");
  });

  it("reads the store and reports writes only on success", async () => {
    const sandbox = new CodemodeSandbox({ runtime: inProcessRuntime() });
    const ok = await sandbox.execute(
      `store("runs", (load("runs") ?? 0) + 1); store("old", undefined);`,
      { store: { runs: 2, old: "x" } },
    );
    expect(ok.ok && ok.storeWrites).toEqual({ set: { runs: 3 }, delete: ["old"] });
    const failed = await sandbox.execute(`store("runs", 9); throw new Error("x");`);
    expect(failed.ok).toBe(false);
    expect("storeWrites" in failed).toBe(false);
  });

  it("reports a runtime that cannot load as a sandbox error", async () => {
    const sandbox = new CodemodeSandbox({
      runtime: () => Promise.reject(new Error("missing quickjs.wasm")),
    });
    const result = await sandbox.execute("return 1;");
    expect(!result.ok && result.error).toMatchObject({
      kind: "sandbox",
      message: expect.stringContaining("missing quickjs.wasm"),
    });
  });
});

function fakeTool(name: string, run: (args: Record<string, unknown>) => string): ToolRegistration {
  return defineTool({
    name,
    description: `${name} tool`,
    parameters: Type.Object({ path: Type.String() }),
    execute: async (args, api) => {
      // Streamed output stands in for content, like Pi's own tools.
      api.output(run(args));
      return {};
    },
  });
}

/** A codemode call outside a Harness: one conversation, a store document, and approvals. */
function codemodeHarness(options: {
  tools: ToolRegistration[];
  active?: string[];
  deny?: string[];
  store?: Record<string, unknown>;
  /** Show an approval prompt for these tools and hold the call until the returned release runs. */
  prompt?: { tools: string[]; release: Promise<void> };
}) {
  const doc = { values: { ...options.store } };
  const approvals: string[] = [];
  const details: unknown[] = [];
  const output: string[] = [];
  const tool = createCodemodeTool({
    tools: options.tools,
    runtime: inProcessRuntime(),
    approve: async (name, args, _api, _signal, onPrompt) => {
      approvals.push(`${name}:${String(args.path)}`);
      if (options.prompt?.tools.includes(name)) {
        onPrompt();
        await options.prompt.release;
      }
      return options.deny?.includes(name) ? "User denied this workspace edit." : undefined;
    },
  });
  const api = {
    taskId: 1,
    conversationId: 1,
    callId: "call-1",
    outputWindow: undefined,
    output: (chunk: string) => output.push(chunk),
    diagnostic: () => undefined,
    details: async (value: unknown) => {
      details.push(value);
    },
    agent: async () => ({
      tools: (options.active ?? options.tools.map((item) => item.name)).map((name) => ({ name })),
    }),
    commit: async (change: (tx: unknown) => unknown) => change({ doc: async () => doc }),
  };
  const run = async (code: string) => {
    const result = await tool.execute({ code } as never, api as never, BACKGROUND_CONTEXT);
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("");
    return { result, text };
  };
  return { tool, run, doc, approvals, details, output };
}

describe("codemode tool", () => {
  const read = fakeTool("read", (args) => `contents of ${String(args.path)}`);
  const write = fakeTool("write", (args) => `wrote ${String(args.path)}`);

  it("runs nested tools and returns only the script output", async () => {
    const { run, approvals } = codemodeHarness({ tools: [read, write] });
    const { result, text } = await run(`
      const files = await Promise.all(["a.ts", "b.ts"].map((path) => tools.read({ path })));
      await tools.write({ path: "out.txt" });
      return files.map((file) => file.length);
    `);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n\[16,16\]$/);
    expect(approvals).toEqual(["read:a.ts", "read:b.ts", "write:out.txt"]);
    expect(result.details).toMatchObject({
      calls: [
        { name: "read", args: { path: "a.ts" }, status: "ok" },
        { name: "read", args: { path: "b.ts" }, status: "ok" },
        { name: "write", args: { path: "out.txt" }, status: "ok" },
      ],
    });
  });

  it("marks a call as waiting while its approval prompt is shown", async () => {
    let release!: () => void;
    const prompt = { tools: ["write"], release: new Promise<void>((r) => (release = r)) };
    const { run, details, output } = codemodeHarness({ tools: [read, write], prompt });
    const pending = run('await tools.read({ path: "a" }); await tools.write({ path: "b" });');
    await vi.waitFor(() =>
      expect(details.at(-1)).toMatchObject({
        calls: [
          { name: "read", status: "ok" },
          { name: "write", status: "waiting" },
        ],
      }),
    );
    expect(output.join("")).toContain("… write is waiting for approval");
    release();
    const { result } = await pending;
    expect(result.details).toMatchObject({
      calls: [
        { name: "read", status: "ok" },
        { name: "write", status: "ok" },
      ],
    });
  });

  it("rejects denied, invalid and unavailable calls inside the script", async () => {
    const { run } = codemodeHarness({ tools: [read, write], deny: ["write"], active: ["write"] });
    const { text } = await run(`
      const results = await Promise.allSettled([
        tools.write({ path: "x" }),
        tools.write({ nope: 1 }),
      ]);
      text(results.map((r) => r.status + ": " + (r.reason?.message ?? r.value)).join("\\n"));
      try { await tools.read({ path: "a" }); } catch (error) { text(error.message); }
    `);
    expect(text).toContain("rejected: User denied this workspace edit.");
    expect(text).toContain('rejected: Validation failed for tool "write"');
    // `read` is not active in this conversation, so scripts cannot call it.
    expect(text).toContain("tools.read does not exist. Available: write.");
  });

  it("never exposes subagents, questions or itself to scripts", async () => {
    const subagent = fakeTool("subagent", () => "");
    const ask = fakeTool("ask_user_question", () => "");
    const { tool, run } = codemodeHarness({ tools: [read, subagent, ask] });
    expect(tool.description).toContain("Callable: read.");
    const { text } = await run(
      'return [ALL_TOOLS.map((t) => t.name), (await searchTools("read")).length, await describeTool("read")];',
    );
    expect(text).toContain('[["read"],1,');
    expect(text).toContain("read(args: { path: string; }): Promise<string>");
  });

  it("marks failures as errors with the calls made so far", async () => {
    const { run } = codemodeHarness({ tools: [read] });
    const { result, text } = await run(
      `await tools.read({ path: "a" });\nthrow new Error("boom");`,
    );
    expect(result.isError).toBe(true);
    expect(text).toContain("Script failed");
    expect(text).toContain("Error: boom");
    expect(text).toContain("Tool calls made before the failure (they are not undone): read (ok)");
  });

  it("records file contents as their size, never their text", async () => {
    const save = defineTool({
      name: "write",
      description: "write",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const { run } = codemodeHarness({ tools: [save] });
    const { result } = await run(
      'await tools.write({ path: "a.txt", content: "secret".repeat(100) });',
    );
    expect(result.details).toEqual({
      calls: [
        {
          name: "write",
          args: { path: "a.txt", content: "[600 characters]" },
          status: "ok",
          durationMs: expect.any(Number),
        },
      ],
    });
  });

  it("keeps store values in the conversation document", async () => {
    const { run, doc } = codemodeHarness({ tools: [], store: { seen: 1 } });
    const { text } = await run(`store("seen", load("seen") + 1); return load("seen");`);
    expect(text).toContain("Output:\n2");
    expect(doc.values).toEqual({ seen: 2 });
  });

  it("rejects malformed options lines", async () => {
    const { run } = codemodeHarness({ tools: [] });
    await expect(run('// @options: {"bogus": 1}\nreturn 1;')).rejects.toThrow(/bogus/);
  });

  it("applies the output budget from the options line", async () => {
    const { run } = codemodeHarness({ tools: [] });
    const { text } = await run(
      '// @options: {"max_output_tokens": 10}\ntext("x".repeat(500)); return "end";',
    );
    expect(text).toContain("Warning: truncated output");
    expect(text).toContain("tokens truncated");
  });
});

describe("codemode output", () => {
  it("labels several text items and gathers console lines last", () => {
    expect(
      formatOutput([
        { type: "text", text: "one" },
        { type: "text", text: "log", console: true },
        { type: "text", text: "two" },
      ]),
    ).toEqual([
      { type: "text", text: "==> text 1/2 <==\none" },
      { type: "text", text: "==> text 2/2 <==\ntwo" },
      { type: "text", text: "<console_output>\nlog\n</console_output>" },
    ]);
  });

  it("keeps images after truncated text", () => {
    const items = truncateOutput(
      [
        { type: "text", text: "a".repeat(100) },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      5,
    );
    expect(items[0]?.type).toBe("text");
    expect(items[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });
});

describe("codemode work log", () => {
  it("splits a result into output, error and wall time", () => {
    expect(
      parseScriptResult(
        "Script failed\nWall time 1.5 seconds\nOutput:\npartial\nScript error:\nError: boom\n\nTool calls made before the failure (they are not undone): read (ok)",
        true,
      ),
    ).toEqual({ output: "partial", error: "Error: boom", wallTimeMs: 1500 });
    expect(parseScriptResult("Script completed\nWall time 0.0 seconds\nOutput:\n")).toEqual({
      output: undefined,
      error: undefined,
      wallTimeMs: 0,
    });
    expect(
      parseScriptResult("<harness>[error] Tool execution was aborted</harness>", true),
    ).toEqual({
      error: "Tool execution was aborted",
    });
  });

  it("reads recorded calls and ignores malformed ones", () => {
    expect(
      scriptCalls({
        calls: [
          { name: "read", args: { path: "a" }, status: "ok", durationMs: 4 },
          { name: "grep", status: "bogus" },
          null,
        ],
        omitted: 3,
      }),
    ).toEqual({
      calls: [{ name: "read", args: { path: "a" }, status: "ok", durationMs: 4, error: undefined }],
      omitted: 3,
    });
    expect(scriptCalls(undefined)).toEqual({ calls: [], omitted: 0 });
  });

  it("names the tools a script calls", () => {
    expect(
      presentTool("codemode", {
        code: 'await tools.read({ path: "a" });\nawait tools["list_dir"]({}); await tools.read({});',
      }),
    ).toMatchObject({ label: "Ran a script", detail: "read, list_dir" });
  });
});

describe("approval prompts", () => {
  const workspace = {
    readText: async () => Promise.reject(new Error("missing")),
  } as unknown as AcodeWorkspace;

  it("reports when a prompt is shown, and not when the mode allows the change", async () => {
    const gate = new MutationGate();
    const shown: string[] = [];
    const asked = gate.request(
      "write",
      { path: "a", content: "x" },
      workspace,
      "ask",
      undefined,
      "Codemode",
      () => shown.push("a"),
    );
    await vi.waitFor(() => expect(gate.pending?.title).toBe("Codemode · Write a"));
    expect(shown).toEqual(["a"]);
    gate.resolve("allow");
    await expect(asked).resolves.toEqual({});

    await gate.request(
      "write",
      { path: "b" },
      workspace,
      "allow-edits",
      undefined,
      "Codemode",
      () => shown.push("b"),
    );
    expect(shown).toEqual(["a"]);
  });
});
