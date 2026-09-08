import { afterEach, expect, test } from "vitest";
import { AgentHarness, BACKGROUND_CONTEXT as context, getOrThrow } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionStore } from "../src/platform/sessionStore";
import { sessionFileSystemFixture } from "./sessionFileSystem.fixture";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const options = (id = "c1") => ({ id, workspaceId: "w", workspaceName: "Project", providerId: "faux", modelId: "test", title: "Hello" });
async function setup() {
	const fixture = await sessionFileSystemFixture(); cleanups.push(fixture.cleanup);
	const store = new SessionStore(fixture.adapter);
	const opened = await store.open(options());
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session: opened.session, models, model: faux.getModel(), compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1024 } }, context);
	const lane = await harness.lane("main", context);
	cleanups.push(async () => { await harness.close(context); await store.release("c1"); });
	return { ...fixture, store, opened, harness, lane, faux };
}

test("persists Pi session messages and metadata across repository restart", async () => {
	const { store, opened, lane, faux, adapter, harness } = await setup();
	faux.setResponses([fauxAssistantMessage("Hi there")]);
	getOrThrow(await lane.prompt("Hello 世界 👋", undefined, context));
	opened.update({ title: "Renamed" }); await opened.persist();
	await harness.close(context); await store.release("c1");
	const reloaded = new SessionStore(adapter); await reloaded.hydrate();
	expect(reloaded.list()[0]).toMatchObject({ id: "c1", title: "Renamed" });
	const again = await reloaded.open(options());
	const branch = await again.session.branch("main", context);
	const entries = await branch!.findEntries({ order: "oldestFirst" }, context);
	expect(entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
	expect(JSON.stringify(entries)).toContain("Hello 世界 👋");
	await reloaded.release("c1");
});

test("uses Pi's branch fork, preserving source and excluding selected user prompt", async () => {
	const { store, lane, faux } = await setup();
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	getOrThrow(await lane.prompt("one", undefined, context));
	getOrThrow(await lane.prompt("two", undefined, context));
	const entries = await lane.findEntries({ order: "oldestFirst" }, context);
	const selected = entries.find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("two"))!;
	await store.fork("c1", { ...options("fork"), updatedAt: Date.now() }, selected.id);
	const fork = await store.open(options("fork"));
	const forkEntries = await (await fork.session.branch("main", context))!.findEntries({ order: "oldestFirst" }, context);
	expect(forkEntries).toHaveLength(2); expect(await lane.findEntries(undefined, context)).toHaveLength(4);
	await store.release("fork");
});

test("exports and imports Pi JSONL through Pi's repository", async () => {
	const { store, lane, faux, adapter } = await setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	getOrThrow(await lane.prompt("question", undefined, context));
	const text = await store.export("c1");
	expect(JSON.parse(text.split("\n")[0])).toMatchObject({ v: 4, kind: "header" });
	await store.import(text, { ...options("imported"), updatedAt: Date.now() });
	const imported = await store.open(options("imported"));
	expect(await (await imported.session.branch("main", context))!.findEntries(undefined, context)).toHaveLength(2);
	await store.release("imported");
	const reloaded = new SessionStore(adapter); await reloaded.hydrate();
	expect(reloaded.list().map((item) => item.id)).toContain("imported");
});

test("repairs an interrupted JSONL tail using Pi and preserves prior transactions", async () => {
	const { store, opened, adapter, lane, faux, harness } = await setup();
	faux.setResponses([fauxAssistantMessage("answer")]);
	getOrThrow(await lane.prompt("question", undefined, context));
	await harness.close(context); await store.release("c1");
	getOrThrow(await adapter.appendFile(opened.session.metadata.path, '{"incomplete":', context));
	const next = new SessionStore(adapter); const restored = await next.open(options());
	expect(await restored.session.findEntries(undefined, context)).toHaveLength(2);
	expect(await next.export("c1")).not.toContain('"incomplete"'); await next.release("c1");
});

test("stores tasks in Pi and deletes them with the session", async () => {
	const { store } = await setup();
	const tasks = { tasks: [{ id: "1", subject: "Inspect", status: "pending" }] };
	await store.saveTasks("c1", tasks); expect(await store.loadTasks("c1")).toEqual(tasks);
	await store.remove("c1"); expect(store.list()).toEqual([]);
});

test("leaves legacy KV chats alone and starts with a filesystem store", async () => {
	const fixture = await sessionFileSystemFixture(); cleanups.push(fixture.cleanup);
	const store = new SessionStore(fixture.adapter); await store.hydrate(); expect(store.list()).toEqual([]);
});

test("redacts persisted secrets without changing live messages or image data", async () => {
	const { store, lane, faux } = await setup();
	faux.setResponses([fauxAssistantMessage("done")]);
	getOrThrow(await lane.prompt("key sk-abcdefghijklmnopqrstuvwxyz", [{ type: "image", data: "c2stYWJjZGVmZ2hpamtsbW5vcA==", mimeType: "image/png" }], context));
	const text = await store.export("c1");
	expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz"); expect(text).toContain("[REDACTED_API_KEY]");
	expect(text).toContain("c2stYWJjZGVmZ2hpamtsbW5vcA==");
	expect(JSON.stringify(await lane.findEntries(undefined, context))).toContain("sk-abcdefghijklmnopqrstuvwxyz");
});

test("importing an open session ID uses the incoming file rather than the local session", async () => {
	const { store, lane, faux } = await setup();
	faux.setResponses([fauxAssistantMessage("local answer")]);
	getOrThrow(await lane.prompt("local question", undefined, context));
	const incoming = (await store.export("c1")).replaceAll("local question", "foreign question");
	await store.import(incoming, { ...options("foreign"), updatedAt: Date.now() });
	expect(await store.export("foreign")).toContain("foreign question");
	expect(await store.export("c1")).not.toContain("foreign question");
	await store.release("foreign");
});

test("Pi tree forks retain alternate paths without moving the source tip", async () => {
	const { store, lane, faux } = await setup();
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	getOrThrow(await lane.prompt("first path", undefined, context));
	const oldTip = await lane.getTipId(context);
	getOrThrow(await lane.navigateTree(null, undefined, context));
	getOrThrow(await lane.prompt("alternate path", undefined, context));
	const activeTip = await lane.getTipId(context);
	await store.fork("c1", { ...options("tree-fork"), updatedAt: Date.now() }, undefined, "main", true);
	const fork = await store.open(options("tree-fork"));
	expect(await fork.session.getEntry(oldTip!, context)).toBeDefined();
	expect(await lane.getTipId(context)).toBe(activeTip);
	expect(await fork.session.findEntries(undefined, context)).toHaveLength(4);
	await store.release("tree-fork");
});
