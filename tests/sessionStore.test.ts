import { afterEach, expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MemoryKvStore } from "../src/platform/kvStore.ts";
import { SessionStore } from "../src/platform/sessionStore.ts";
import { sessionEntriesFromMessages, titleFromEntries } from "../src/session/sessionText.ts";

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function installLocalStorage() {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, String(value));
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
		clear: () => data.clear(),
		key: (index: number) => [...data.keys()][index] ?? null,
		get length() {
			return data.size;
		},
	};
	Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
	return storage;
}

afterEach(() => {
	try {
		globalThis.localStorage?.clear();
	} catch {
		// Node tests without a Storage polyfill.
	}
});

test("turns a flat message array into a linear session tree", () => {
	const entries = sessionEntriesFromMessages([
		user("hello", 10),
		user("again", 20),
	]);
	expect(entries).toHaveLength(2);
	expect(entries[0]?.type).toBe("message");
	expect(entries[0]?.parentId).toBeNull();
	expect(entries[1]?.parentId).toBe(entries[0]?.id);
	expect(titleFromEntries(entries)).toBe("hello");
});

test("persists sessions through a KV adapter and reloads them", async () => {
	const kv = new MemoryKvStore();
	const store = new SessionStore(kv);
	await store.hydrate();
	const opened = await store.open({
		id: "c1",
		workspaceId: "w1",
		workspaceName: "acode-ai-agent",
		providerId: "openrouter",
		modelId: "model-a",
		title: "New chat",
	});
	opened.update({ title: "Map the project" });
	await opened.persist();

	expect(store.list()).toEqual([
		expect.objectContaining({ id: "c1", title: "Map the project", workspaceId: "w1", workspaceName: "acode-ai-agent" }),
	]);

	const reloaded = new SessionStore(kv);
	await reloaded.hydrate();
	expect(reloaded.list()[0]).toMatchObject({ id: "c1", title: "Map the project", workspaceId: "w1" });
	const again = await reloaded.open({
		id: "c1",
		workspaceId: "w1",
		providerId: "openrouter",
		modelId: "model-a",
	});
	expect(again.record.title).toBe("Map the project");
	expect(again.record.modelId).toBe("model-a");
});

test("removes a session from the adapter", async () => {
	const kv = new MemoryKvStore();
	const store = new SessionStore(kv);
	const opened = await store.open({
		id: "gone",
		workspaceId: "w",
		providerId: "openrouter",
		modelId: "m",
	});
	await opened.persist();
	await store.remove("gone");
	expect(store.list()).toEqual([]);
	expect(await kv.get("acode.ai-agent.session.v3:gone")).toBeUndefined();
});

test("redacts secrets before writing a session", async () => {
	const kv = new MemoryKvStore();
	const store = new SessionStore(kv);
	const opened = await store.open({
		id: "safe",
		workspaceId: "w",
		providerId: "openrouter",
		modelId: "m",
	});
	opened.update({ title: "use sk-abcdefghijklmnopqrstuvwxyz" });
	await opened.persist();
	const record = await kv.get("acode.ai-agent.session.v3:safe") as { title: string };
	expect(record.title).toBe("use [REDACTED_API_KEY]");
	expect(store.list()[0]?.title).toBe("use [REDACTED_API_KEY]");
});

test("migrates localStorage v3 sessions into the adapter and clears the old keys", async () => {
	const local = installLocalStorage();
	local.setItem("acode.ai-agent.chats.v3", JSON.stringify({
		chats: [{ id: "old", title: "Hello", workspaceId: "w", updatedAt: 10 }],
	}));
	local.setItem("acode.ai-agent.session.v3:old", JSON.stringify({
		id: "old",
		title: "Hello",
		workspaceId: "w",
		providerId: "openrouter",
		modelId: "x",
		createdAt: "2020-01-01T00:00:00.000Z",
		updatedAt: 10,
		leafId: null,
		entries: [],
	}));

	const store = new SessionStore(new MemoryKvStore());
	await store.hydrate();
	expect(store.list()).toEqual([
		{ id: "old", title: "Hello", workspaceId: "w", workspaceName: "", updatedAt: 10 },
	]);
	expect(local.getItem("acode.ai-agent.chats.v3")).toBeNull();
	expect(local.getItem("acode.ai-agent.session.v3:old")).toBeNull();
});

test("migrates v2 localStorage chats into the adapter", async () => {
	const local = installLocalStorage();
	local.setItem("acode.ai-agent.chats.v2", JSON.stringify({
		chats: [{ id: "v2", title: "Imported", workspaceId: "w", updatedAt: 20 }],
	}));
	local.setItem("acode.ai-agent.chat.v2:v2", JSON.stringify({
		id: "v2",
		title: "Imported",
		workspaceId: "w",
		providerId: "anthropic",
		modelId: "claude",
		messages: [user("please review src/main.ts", 20)],
		updatedAt: 20,
	}));

	const store = new SessionStore(new MemoryKvStore());
	await store.hydrate();
	expect(store.list()[0]).toMatchObject({ id: "v2", title: "Imported", workspaceId: "w" });
	const opened = await store.open({
		id: "v2",
		workspaceId: "w",
		providerId: "anthropic",
		modelId: "claude",
	});
	expect(opened.record.providerId).toBe("anthropic");
});

test("persists, copies, and deletes session task lists", async () => {
	const kv = new MemoryKvStore();
	const store = new SessionStore(kv);
	await store.saveTasks("c1", { nextId: 3, tasks: [{ id: "1", subject: "Inspect", status: "completed" }] });
	expect(await store.loadTasks("c1")).toEqual({ nextId: 3, tasks: [{ id: "1", subject: "Inspect", status: "completed" }] });
	await store.copyTasks("c1", "c2");
	expect(await store.loadTasks("c2")).toEqual({ nextId: 3, tasks: [{ id: "1", subject: "Inspect", status: "completed" }] });
	await store.saveTasks("c1", { nextId: 3, tasks: [] });
	expect(await store.loadTasks("c1")).toBeUndefined();
	await store.open({ id: "c2", workspaceId: "w", providerId: "openrouter", modelId: "m" });
	await store.remove("c2");
	expect(await store.loadTasks("c2")).toBeUndefined();
});
