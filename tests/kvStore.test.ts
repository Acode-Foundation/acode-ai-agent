import { afterEach, expect, test } from "vitest";
import { createKvStore, detectAcodeKv, MemoryKvStore } from "../src/platform/kvStore.ts";

const originalAcode = (globalThis as { acode?: unknown }).acode;

afterEach(() => {
	if (originalAcode === undefined) delete (globalThis as { acode?: unknown }).acode;
	else (globalThis as { acode?: unknown }).acode = originalAcode;
});

test("memory store round-trips JSON documents", async () => {
	const kv = new MemoryKvStore();
	await kv.set("session:1", { title: "Hi", entries: [1, 2] });
	expect(await kv.get("session:1")).toEqual({ title: "Hi", entries: [1, 2] });
	expect(await kv.keys()).toEqual(["session:1"]);
	await kv.delete("session:1");
	expect(await kv.get("session:1")).toBeUndefined();
});

test("memory store clones values so callers cannot mutate storage", async () => {
	const kv = new MemoryKvStore();
	const value = { title: "Hi" };
	await kv.set("k", value);
	value.title = "changed";
	const stored = await kv.get("k") as { title: string };
	expect(stored.title).toBe("Hi");
	stored.title = "mutated";
	expect(await kv.get("k")).toEqual({ title: "Hi" });
});

test("detects a future Acode KV API and wraps string values", async () => {
	const data = new Map<string, string>();
	const host = {
		async get(key: string) {
			return data.get(key);
		},
		async set(key: string, value: unknown) {
			data.set(key, String(value));
		},
		async delete(key: string) {
			data.delete(key);
		},
		async keys() {
			return [...data.keys()];
		},
	};
	(globalThis as { acode?: { kv: typeof host } }).acode = { kv: host };
	const kv = detectAcodeKv();
	expect(kv?.driver).toBe("acode");
	await kv?.set("chat", { id: "1", title: "Hi" });
	expect(data.get("chat")).toBe(JSON.stringify({ id: "1", title: "Hi" }));
	expect(await kv?.get("chat")).toEqual({ id: "1", title: "Hi" });
});

test("createKvStore prefers a context KV over IndexedDB", async () => {
	const ctx = {
		kv: new MemoryKvStore(),
	} as unknown as Acode.PluginContext;
	const kv = createKvStore(ctx);
	expect(kv.driver).toBe("acode");
	await kv.set("x", { ok: true });
	expect(await kv.get("x")).toEqual({ ok: true });
});

test("createKvStore falls back to memory when no host or IndexedDB exists", () => {
	const acode = (globalThis as { acode?: unknown }).acode;
	delete (globalThis as { acode?: unknown }).acode;
	const indexed = (globalThis as { indexedDB?: unknown }).indexedDB;
	Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
	try {
		expect(createKvStore().driver).toBe("memory");
	} finally {
		Object.defineProperty(globalThis, "indexedDB", { value: indexed, configurable: true });
		if (acode !== undefined) (globalThis as { acode?: unknown }).acode = acode;
	}
});
