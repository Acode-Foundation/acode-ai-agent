import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { createCodemodeTool } from "../src/codemode/createCodemodeTool";
import { MutationGate } from "../src/permissions/mutationGate";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";
import { formatOutput, truncateOutput } from "../src/codemode/output";
import { CodemodeSandbox } from "../src/codemode/sandbox";
import { parseScriptResult, presentTool, scriptCalls } from "../src/ui/transcript";
import { inProcessRuntime } from "./toolHarness";

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
  deferred?: string[];
  deny?: string[];
  store?: Record<string, unknown>;
  /** Show an approval prompt for these tools and hold the call until the returned release runs. */
  prompt?: { tools: string[]; release: Promise<void> };
  models?: unknown;
  saveImage?: (path: string, image: { data: string; mimeType: string }) => Promise<string>;
}) {
  const doc = { values: { ...options.store } };
  const approvals: string[] = [];
  const details: unknown[] = [];
  const output: string[] = [];
  const tool = createCodemodeTool({
    tools: options.tools,
    deferred: new Set(options.deferred ?? []),
    saveImage: options.saveImage && ((path, image) => options.saveImage!(path, image)),
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
    models: options.models,
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

  it("calls deferred tools in user chats without loading them", async () => {
    const { run } = codemodeHarness({
      tools: [read, write],
      active: ["read"],
      deferred: ["write"],
    });
    const { text } = await run('return await tools.write({ path: "x" });');
    expect(text).toContain("wrote x");
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
    expect(
      presentTool("codemode", {
        code: 'const m = await models.getModelOfType("image", "a", "b"); await saveImage("x.png", m);',
      }),
    ).toMatchObject({ detail: "models.getModelOfType, saveImage" });
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

describe("codemode models", () => {
  const painter = {
    provider: "openrouter",
    id: "google/gemini-2.5-flash-image",
    api: "openrouter-images",
  };
  const judge = { provider: "openrouter", id: "typesafe/jev-1.13", api: "typesafe-system-one" };
  const usage = (total: number) => ({
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  function fakeModels(overrides: Record<string, unknown> = {}) {
    let active = 0;
    const stats = { maxActive: 0 };
    const models = {
      getModelsOfType: (type: string) =>
        type === "image" ? [{ ...painter, headers: { Authorization: "secret" } }] : [judge],
      getAvailableOfType: async (type: string) => (type === "image" ? [painter] : [judge]),
      getModelOfType: (type: string, provider: string, id: string) =>
        [painter, judge].find(
          (model) =>
            model.provider === provider &&
            model.id === id &&
            (type === "image"
              ? model === painter
              : type === "classifier"
                ? model === judge
                : false),
        ),
      generateImages: async () => ({
        output: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        stopReason: "stop",
        usage: usage(0.04),
      }),
      classify: async () => {
        active += 1;
        stats.maxActive = Math.max(stats.maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          answers: { ok: { type: "bool", probability: 0.9 } },
          stopReason: "stop",
          usage: usage(0.01),
        };
      },
      ...overrides,
    };
    return { models, stats };
  }

  it("generates images, shows them, and counts their cost", async () => {
    const { models } = fakeModels();
    const { run } = codemodeHarness({ tools: [], models });
    const { result, text } = await run(`
      const [model] = await models.getAvailableOfType("image");
      const made = await models.generateImages(model, { input: [{ type: "text", text: "a fox" }] });
      for (const block of made.output) image(block);
      return made.stopReason;
    `);
    expect(text).toContain("stop");
    expect(result.content?.some((part) => part.type === "image")).toBe(true);
    expect(result.usage?.cost.total).toBeCloseTo(0.04);
    expect(result.details).toMatchObject({
      calls: [
        {
          name: "models.generateImages",
          args: { model: "openrouter/google/gemini-2.5-flash-image" },
          status: "ok",
        },
      ],
    });
  });

  it("notes images the script neither showed nor saved", async () => {
    const { models } = fakeModels();
    const { text } = await run(
      models,
      `
      const model = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
      await models.generateImages(model, { input: [{ type: "text", text: "a fox" }] });
    `,
    );
    expect(text).toContain("neither showed nor saved");
  });

  it("explains malformed calls and wrong model types", async () => {
    const { models } = fakeModels();
    const { text } = await run(
      models,
      `
      const judge = await models.getModelOfType("classifier", "openrouter", "typesafe/jev-1.13");
      const errors = [];
      try { await models.classify(judge, { state: {} }); } catch (error) { errors.push(error.message); }
      try { await models.generateImages(judge, { input: [{ type: "text", text: "x" }] }); } catch (error) { errors.push(error.message); }
      try { await models.generateImages(undefined, {}); } catch (error) { errors.push(error.message); }
      return errors.join("\\n");
    `,
    );
    expect(text).toContain("context.questions must map question ids");
    expect(text).toContain("is a classifier model, not an image model");
    expect(text).toContain("returns undefined for an unknown provider or id");
  });

  it("runs at most four model calls at once and sums their cost", async () => {
    const { models, stats } = fakeModels();
    const { result } = await run(
      models,
      `
      const judge = await models.getModelOfType("classifier", "openrouter", "typesafe/jev-1.13");
      const question = { ok: { type: "bool", instructions: "ok?", criteria: { true: "yes", false: "no" } } };
      await Promise.all(Array.from({ length: 6 }, () => models.classify(judge, { state: { a: 1 }, questions: question })));
    `,
    );
    expect(stats.maxActive).toBe(4);
    expect(result.usage?.cost.total).toBeCloseTo(0.06);
  });

  it("accepts a model named by string", async () => {
    const { models } = fakeModels();
    const { text } = await run(
      models,
      `
      const a = await models.generateImages("openrouter/google/gemini-2.5-flash-image", { input: [{ type: "text", text: "x" }] });
      const b = await models.generateImages("google/gemini-2.5-flash-image", { input: [{ type: "text", text: "x" }] });
      let error = "";
      try { await models.generateImages("nope/model", { input: [{ type: "text", text: "x" }] }); } catch (e) { error = e.message; }
      image(a.output[0]); image(b.output[0]);
      return [a.stopReason, b.stopReason, error];
    `,
    );
    expect(text).toContain('["stop","stop","Unknown image model \\"nope/model\\"');
  });

  it("never hands scripts a model's request headers", async () => {
    const { models } = fakeModels();
    const { text } = await run(models, 'return await models.getModelsOfType("image");');
    expect(text).toContain("gemini-2.5-flash-image");
    expect(text).not.toContain("secret");
  });

  it("saves images through the host and records the call", async () => {
    const { models } = fakeModels();
    const saved: Array<{ path: string; mimeType: string }> = [];
    const { run: runWithSave } = codemodeHarness({
      tools: [],
      models,
      saveImage: async (path, image) => {
        saved.push({ path, mimeType: image.mimeType });
        return path;
      },
    });
    const { result, text } = await runWithSave(`
      const model = await models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
      const made = await models.generateImages(model, { input: [{ type: "text", text: "an icon" }] });
      return await saveImage("assets/icon.png", made.output[0]);
    `);
    expect(saved).toEqual([{ path: "assets/icon.png", mimeType: "image/png" }]);
    expect(text).toContain("assets/icon.png");
    expect(text).not.toContain("neither showed nor saved");
    expect(result.details).toMatchObject({
      calls: [
        { name: "models.generateImages" },
        { name: "saveImage", args: { path: "assets/icon.png" }, status: "ok" },
      ],
    });
  });

  function run(models: unknown, code: string) {
    return codemodeHarness({ tools: [], models }).run(code);
  }
});
