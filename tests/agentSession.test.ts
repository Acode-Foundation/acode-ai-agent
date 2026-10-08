import "fake-indexeddb/auto";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, test, vi } from "vitest";
import { ExtensionRegistry } from "../src/core/extensionRegistry";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { MutationGate } from "../src/permissions/mutationGate";
import { openAgentDatabase } from "../src/platform/idbFileSystem";
import type { ProviderRegistry } from "../src/providers/providerRegistry";
import { AgentSession, type AgentSessionSnapshot } from "../src/session/agentSession";
import { ChatStore, type ChatMeta } from "../src/session/chatStore";
import { fromPiSessionJsonl } from "../src/session/history";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";

const cleanups: Array<() => Promise<unknown>> = [];
let databases = 0;

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined);
  vi.unstubAllGlobals();
});

function environment() {
  vi.stubGlobal("window", { editorManager: { files: [] } });
  vi.stubGlobal("acode", { require: () => undefined });
  databases += 1;
  const store = new ChatStore(openAgentDatabase(`session-test-${databases}`));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const providers = {
    models,
    harnessModels: models,
    resolveModel: () => faux.getModel(),
  } as unknown as ProviderRegistry;
  const files: Record<string, string> = { "a.txt": "alpha\n" };
  const workspace = {
    info: {
      id: "workspace",
      name: "Project",
      rootUri: "file:///workspace",
      scheme: "file",
      remote: false,
    },
    sandbox: {
      normalize: (path: string) => path.replace(/^\/+/, ""),
      relative: () => undefined,
    },
    walk: async () => ({ visited: 0, stop: "done", skippedFolders: [] }),
    list: async () => [],
    stat: async (path: string) => {
      if (!(path in files)) throw new Error("not found");
      return { isDirectory: false, size: files[path]!.length, modifiedDate: 0 };
    },
    readText: async (path: string) => {
      if (!(path in files)) throw new Error(`No such file: ${path}`);
      return files[path]!;
    },
    readBinary: async (path: string) => new TextEncoder().encode(files[path] ?? ""),
    writeText: vi.fn(async (path: string, content: string) => {
      files[path] = content;
      return "disk" as const;
    }),
    remove: vi.fn(async (path: string) => {
      delete files[path];
      return { kind: "file", from: path };
    }),
  } as unknown as AcodeWorkspace;
  const settings = {
    ...DEFAULT_SETTINGS,
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
    thinkingLevel: "off" as const,
    autoCompaction: false,
    retryEnabled: false,
  };
  const extensions = new ExtensionRegistry();
  const open = async (meta: ChatMeta) => {
    const gate = new MutationGate();
    const session = new AgentSession({
      meta,
      workspace,
      providers,
      extensions,
      settings: () => settings,
      store,
      mutationGate: gate,
    });
    cleanups.push(() => session.dispose());
    await session.initialize();
    return { session, gate };
  };
  const newMeta = (id: string): ChatMeta => ({
    id,
    title: "New chat",
    workspaceId: "workspace",
    workspaceName: "Project",
    createdAt: 1,
    updatedAt: 1,
  });
  return { store, faux, settings, files, workspace, open, newMeta };
}

function settle(session: AgentSession, done: (snapshot: AgentSessionSnapshot) => boolean) {
  return vi.waitFor(
    () => {
      const snapshot = session.snapshot;
      if (!done(snapshot)) throw new Error("not yet");
      return snapshot;
    },
    { timeout: 3_000, interval: 5 },
  );
}

const idle = (snapshot: AgentSessionSnapshot) =>
  !snapshot.isRunning && snapshot.messages.length > 0;

test("runs a prompt through Pi and reopens the chat from IndexedDB", async () => {
  const env = environment();
  const meta = env.newMeta("chat-1");
  await env.store.save(meta);
  const { session } = await env.open(meta);
  env.faux.setResponses([fauxAssistantMessage("Hello from Pi")]);

  await session.prompt("hello there");
  const done = await settle(session, idle);
  expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  await vi.waitFor(() => expect(env.store.get("chat-1")?.title).toBe("hello there"));
  expect(await session.treeItems()).toHaveLength(2);
  const exported = await session.exportJsonl();
  expect(fromPiSessionJsonl(exported).map((entry) => entry.kind)).toEqual([
    "pi.user",
    "pi.assistant",
  ]);
  await session.dispose();

  const reopened = await env.open(env.store.get("chat-1")!);
  expect(reopened.session.snapshot.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(reopened.session.snapshot.recovery).toBeUndefined();
});

test("runs Pi's read tool against the workspace", async () => {
  const env = environment();
  const { session } = await env.open(env.newMeta("chat-read"));
  env.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("It says alpha."),
  ]);

  await session.prompt("what is in a.txt?");
  const done = await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length >= 4);
  const result = done.messages.find((message) => message.role === "toolResult");
  expect(result && "content" in result ? JSON.stringify(result.content) : "").toContain("alpha");
});

test("the approval gate blocks a denied write without touching the workspace", async () => {
  const env = environment();
  const { session, gate } = await env.open(env.newMeta("chat-gate"));
  env.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "new" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Understood."),
  ]);

  await session.prompt("write b.txt");
  await vi.waitFor(() => expect(gate.pending?.toolName).toBe("write"));
  gate.resolve("deny");
  const done = await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length >= 4);
  const result = done.messages.find((message) => message.role === "toolResult");
  expect(result?.role === "toolResult" && result.isError).toBe(true);
  expect(env.workspace.writeText).not.toHaveBeenCalled();
});

test("abort stops the run and returns queued prompts for the composer", async () => {
  const env = environment();
  const { session } = await env.open(env.newMeta("chat-abort"));
  const hang: FauxResponseStep = (_context, options) =>
    new Promise((_resolve, reject) =>
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  env.faux.setResponses([hang]);

  await session.prompt("first");
  await settle(session, (snapshot) => snapshot.isRunning);
  await session.prompt("second", "followUp");
  await settle(session, (snapshot) => snapshot.queued.length === 1);
  const restored = await session.abort();
  expect(restored.map((item) => item.text)).toEqual(["second"]);
  const done = await settle(
    session,
    (snapshot) => !snapshot.isRunning && snapshot.messages.at(-1)?.role === "runNotice",
  );
  expect(done.queued).toEqual([]);
  expect(done.messages.at(-1)).toMatchObject({ role: "runNotice" });

  // The notice comes from Pi's submission record; nothing extra reaches the model.
  let seen: string[] = [];
  env.faux.setResponses([
    (context) => {
      seen = context.messages.map((message) => message.role);
      return fauxAssistantMessage("after stop");
    },
  ]);
  await session.prompt("third");
  await settle(session, (snapshot) =>
    snapshot.messages.some((message) => JSON.stringify(message).includes("after stop")),
  );
  expect(seen).not.toContain("runNotice");
});

test("offers to resume a run the previous app session left unfinished", async () => {
  const env = environment();
  const meta = env.newMeta("chat-resume");
  await env.store.save(meta);
  const first = await env.open(meta);
  const hang: FauxResponseStep = (_context, options) =>
    new Promise((_resolve, reject) =>
      options?.signal?.addEventListener("abort", () => reject(new Error("closed"))),
    );
  env.faux.setResponses([hang]);
  await first.session.prompt("keep going");
  await settle(first.session, (snapshot) => snapshot.isRunning);
  await first.session.dispose();

  env.faux.setResponses([fauxAssistantMessage("Resumed answer")]);
  const { session } = await env.open(env.store.get("chat-resume")!);
  expect(session.snapshot.recovery?.kind).toBe("interrupted");
  // Nothing runs until the user resumes, so Resume and Discard stay usable.
  expect(session.snapshot.isRunning).toBe(false);
  await session.resume();
  const done = await settle(
    session,
    (snapshot) =>
      !snapshot.isRunning &&
      snapshot.messages.some(
        (message) =>
          message.role === "assistant" && JSON.stringify(message).includes("Resumed answer"),
      ),
  );
  expect(done.recovery).toBeUndefined();
});

test("tree navigation branches before a user message and can return to the old branch", async () => {
  const env = environment();
  const { session } = await env.open(env.newMeta("chat-tree"));
  env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await session.prompt("first question");
  await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length === 2);
  await session.prompt("second question");
  await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length === 4);

  const items = await session.treeItems();
  const second = items.find((item) => item.kind === "user" && item.text === "second question")!;
  const oldTip = items.find((item) => item.current)!;
  expect(await session.navigateTree(second.id)).toBe("second question");
  expect(session.snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

  await session.navigateTree(oldTip.id);
  expect(session.snapshot.messages).toHaveLength(4);
});

test("copies history into a new chat for /fork", async () => {
  const env = environment();
  const { session } = await env.open(env.newMeta("chat-source"));
  env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await session.prompt("first question");
  await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length === 2);
  await session.prompt("second question");
  await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length === 4);
  const second = (await session.treeItems()).find((item) => item.text === "second question")!;

  const { entries, restoredText } = await session.historyUntil(second.id);
  expect(restoredText).toBe("second question");
  const target = await env.open(env.newMeta("chat-fork"));
  await target.session.importHistory(entries);
  expect(target.session.snapshot.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
});

test("manual compaction keeps a summary and the chat stays usable", async () => {
  const env = environment();
  env.settings.compactionKeepRecentTokens = 1;
  const { session } = await env.open(env.newMeta("chat-compact"));
  env.faux.setResponses([
    fauxAssistantMessage("one"),
    fauxAssistantMessage("two"),
    fauxAssistantMessage("Summary of the work so far."),
  ]);
  await session.prompt("first question");
  await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length === 2);
  await session.prompt("second question");
  await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length === 4);

  await session.compact();
  const done = await settle(session, (snapshot) =>
    snapshot.messages.some((message) => message.role === "compactionSummary"),
  );
  const summary = done.messages.find((message) => message.role === "compactionSummary");
  expect(summary && "summary" in summary ? summary.summary : "").toContain("Summary of the work");
  env.faux.appendResponses([fauxAssistantMessage("three")]);
  await session.prompt("third question");
  await settle(session, (snapshot) =>
    snapshot.messages.some((message) => JSON.stringify(message).includes("three")),
  );
});

test("deleting a chat removes its storage", async () => {
  const env = environment();
  const meta = env.newMeta("chat-delete");
  await env.store.save(meta);
  const { session } = await env.open(meta);
  env.faux.setResponses([fauxAssistantMessage("bye")]);
  await session.prompt("hello");
  await settle(session, idle);
  await session.dispose();
  await env.store.remove("chat-delete");
  expect(env.store.get("chat-delete")).toBeUndefined();
  const reopened = await env.open(env.newMeta("chat-delete"));
  expect(reopened.session.snapshot.messages).toEqual([]);
});

test("a subagent runs in its own child conversation and reports back", async () => {
  const env = environment();
  const { session } = await env.open(env.newMeta("chat-subagent"));
  let childTools: string[] = [];
  env.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("subagent", { task: "Find where alpha is defined.", agent: "explore" })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      // Pi declares tools in positional system messages, not a separate tool list.
      childTools = context.messages.flatMap((message) =>
        message.role === "system"
          ? ((message as { toolsAdded?: Array<{ name: string }> }).toolsAdded ?? []).map(
              (tool) => tool.name,
            )
          : [],
      );
      return fauxAssistantMessage("alpha is in a.txt line 1");
    },
    fauxAssistantMessage("The subagent found it in a.txt."),
  ]);

  await session.prompt("where is alpha?");
  const done = await settle(session, (snapshot) => idle(snapshot) && snapshot.messages.length >= 4);
  const result = done.messages.find((message) => message.role === "toolResult");
  expect(result && "content" in result ? JSON.stringify(result.content) : "").toContain(
    "alpha is in a.txt line 1",
  );
  // explore children read and search only; nobody delegates further or talks to the user.
  expect(childTools).toEqual(expect.arrayContaining(["read", "grep", "glob", "list_dir"]));
  for (const name of ["subagent", "write", "edit", "todo_write", "ask_user_question"])
    expect(childTools).not.toContain(name);
  // The child conversation is not one of the user's branches.
  expect((await session.treeItems()).every((item) => !item.text.includes("alpha is in"))).toBe(
    true,
  );
});

test("reverts the files a turn changed, and asks before overwriting later changes", async () => {
  const env = environment();
  env.settings.permissionMode = "full-access";
  const { session } = await env.open(env.newMeta("chat-revert"));
  env.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("write", { path: "new.txt", content: "created" }),
        fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "alpha", newText: "beta" }] }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await session.prompt("change things");
  const done = await settle(
    session,
    (snapshot) => idle(snapshot) && Object.keys(snapshot.edits).length > 0,
  );
  expect(env.files).toMatchObject({ "a.txt": "beta\n", "new.txt": "created" });
  const [entryId, summary] = Object.entries(done.edits)[0]!;
  expect(summary).toEqual({
    files: [
      { path: "new.txt", added: 1, removed: 0, created: true, skipped: false },
      { path: "a.txt", added: 1, removed: 1, created: false, skipped: false },
    ],
    added: 2,
    removed: 1,
    reverted: false,
  });

  env.files["a.txt"] = "beta changed by the user\n";
  const blocked = await session.revertRun(entryId);
  expect(blocked).toEqual({ reverted: [], conflicts: ["a.txt"], skipped: [] });
  expect(env.files["a.txt"]).toBe("beta changed by the user\n");

  const forced = await session.revertRun(entryId, true);
  expect(forced.reverted.sort()).toEqual(["a.txt", "new.txt"]);
  expect(env.files).toEqual({ "a.txt": "alpha\n" });
  expect(session.snapshot.edits[entryId]?.reverted).toBe(true);
  await expect(session.revertRun(entryId)).rejects.toThrow("already reverted");

  // The model is told, but the note is not shown as a chat message.
  let lastRequest = "";
  env.faux.setResponses([
    (context) => {
      lastRequest = JSON.stringify(context.messages.at(-2));
      return fauxAssistantMessage("ok");
    },
  ]);
  await session.prompt("next");
  await settle(session, (snapshot) =>
    snapshot.messages.some((message) => JSON.stringify(message).includes('"ok"')),
  );
  expect(lastRequest).toContain("reverted the file changes");
  expect(
    session.snapshot.messages.some((message) => JSON.stringify(message).includes("reverted the")),
  ).toBe(false);
});

test("stopping one subagent ends just that call and the run continues", async () => {
  const env = environment();
  const { session } = await env.open(env.newMeta("chat-subagent-stop"));
  let childAsked = false;
  env.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { task: "Search forever." })], {
      stopReason: "toolUse",
    }),
    (_context, options) => {
      childAsked = true;
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    fauxAssistantMessage("Carried on without it."),
  ]);
  await session.prompt("delegate something");
  // Stop once the child is waiting on its model, so the scripted replies stay in order.
  await vi.waitFor(() => expect(childAsked).toBe(true));
  const running = await settle(session, (snapshot) =>
    snapshot.activities.some((item) => item.name === "subagent" && item.status === "running"),
  );
  await session.stopTool(running.activities.find((item) => item.name === "subagent")!.id);
  const done = await settle(session, (snapshot) =>
    snapshot.messages.some((message) => JSON.stringify(message).includes("Carried on")),
  );
  const result = done.messages.find((message) => message.role === "toolResult");
  expect(result?.role === "toolResult" && result.isError).toBe(true);
  expect(done.isRunning).toBe(false);
});
