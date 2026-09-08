import { afterEach, expect, test, vi } from "vitest";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession } from "../src/session/agentSession";
import { SessionStore } from "../src/platform/sessionStore";
import { ExtensionRegistry } from "../src/core/extensionRegistry";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { MutationGate } from "../src/permissions/mutationGate";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";
import type { ProviderRegistry } from "../src/providers/providerRegistry";
import { sessionFileSystemFixture } from "./sessionFileSystem.fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.unstubAllGlobals(); });
async function setup() {
	const fixture = await sessionFileSystemFixture(); cleanups.push(fixture.cleanup);
	vi.stubGlobal("window", {});
	vi.stubGlobal("acode", { require: () => undefined });
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const providers = { models, resolveModel: () => faux.getModel() } as unknown as ProviderRegistry;
	const workspace = { info: { id: "workspace", name: "Project", rootUri: "file:///workspace", remote: false }, sandbox: { normalize: (path: string) => path }, walk: async () => {}, list: async () => [], readText: async () => "", writeText: vi.fn(), } as unknown as AcodeWorkspace;
	const store = new SessionStore(fixture.adapter); const extensions = new ExtensionRegistry(); const gate = new MutationGate();
	const settings = { ...DEFAULT_SETTINGS, providerId: faux.provider.id, modelId: faux.getModel().id, autoCompaction: false, retryEnabled: false };
	const session = new AgentSession({ id: "integration", workspace, providers, extensions, settings: () => settings, store, mutationGate: gate });
	cleanups.push(() => session.dispose());
	await session.initialize();
	return { session, store, extensions, faux, gate, settings, workspace };
}

test("streams a real Pi lane into the UI and reopens persisted messages", async () => {
	const { session, faux, store } = await setup();
	faux.setResponses([fauxAssistantMessage("Hello from Pi")]);
	await session.prompt("hello");
	expect(session.snapshot.isRunning).toBe(false);
	expect(session.snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(await session.treeItems()).toHaveLength(2);
	const exported = await session.exportJsonl(); expect(exported).toContain("Hello from Pi");
	await session.rename("Renamed chat");
	await session.dispose();
	const reopened = await store.open({ id: "integration", workspaceId: "workspace", providerId: "faux", modelId: "test" });
	expect(reopened.record.title).toBe("Renamed chat"); await store.release("integration");
});

test("Pi before_tool blocks a denied edit without executing the tool", async () => {
	const { session, faux, gate, workspace } = await setup();
	// Use the built-in write_file: denying must avoid reaching the workspace writer.
	gate.changes.subscribe((request) => { if (request) gate.resolve("deny"); });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("write_file", { path: "a.txt", content: "no" }), { stopReason: "toolUse" }), fauxAssistantMessage("Edit denied")]);
	await session.prompt("write it");
	expect(JSON.stringify(session.snapshot.messages)).toContain("User denied");
	expect(session.snapshot.error).toBeUndefined();
	expect(workspace.writeText).not.toHaveBeenCalled();
});

test("adapts tool progress and cancellation, and preserves queued input on abort", async () => {
	const { session, extensions, faux } = await setup();
	let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
	extensions.registerTool({ name: "wait_tool", label: "Wait", description: "Wait", parameters: Type.Object({}), execute: async (_id, _params, signal, update) => {
		update?.({ content: [{ type: "text", text: "working" }], details: {} }); started();
		await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
		return { content: [{ type: "text", text: "stopped" }], details: {} };
	} });
	await session.refreshTools();
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait_tool", {}), { stopReason: "toolUse" })]);
	const run = session.prompt("wait"); await ready;
	await session.prompt("do this next", "followUp");
	expect(session.snapshot.queued[0]?.text).toBe("do this next");
	const restored = await session.abort(); await run;
	expect(restored[0]?.text).toBe("do this next");
	expect(session.snapshot.isRunning).toBe(false);
});

test("manual compaction uses Pi's summary and keeps the session usable", async () => {
	const { session, faux, settings } = await setup();
	settings.compactionKeepRecentTokens = 1024;
	settings.compactionReserveTokens = 1024;
	await session.applySettings(settings);
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("A response ".repeat(500))));
	await session.prompt("First question ".repeat(500));
	await session.prompt("Second question ".repeat(500));
	await session.compact();
	expect(session.snapshot.messages.some((message) => message.role === "compactionSummary")).toBe(true);
	expect(session.snapshot.isRunning).toBe(false);
	await session.prompt("Continue");
	expect(session.snapshot.messages.at(-1)?.role).toBe("assistant");
});
