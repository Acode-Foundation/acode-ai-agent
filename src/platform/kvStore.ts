/** String-keyed JSON document store. Swap the driver without touching session code. */
export type KvStore = {
	readonly driver: "acode" | "indexeddb" | "memory";
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
};

type HostKv = {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete?(key: string): Promise<void>;
	remove?(key: string): Promise<void>;
	keys?(): Promise<string[]>;
};

const IDB_NAME = "acode-ai-agent";
const IDB_VERSION = 1;
const IDB_STORE = "kv";

/**
 * Prefer a host KV API when Acode exposes one. IndexedDB is the current
 * default; memory is last resort if both host and IndexedDB are unavailable.
 */
export function createKvStore(ctx?: Acode.PluginContext | null): KvStore {
	try {
		const host = detectAcodeKv(ctx);
		if (host) return host;
	} catch (error) {
		console.warn("Acode session storage adapter is unavailable", error);
	}
	if (typeof indexedDB !== "undefined") return new IndexedDbKvStore();
	return new MemoryKvStore();
}

export function detectAcodeKv(ctx?: Acode.PluginContext | null): KvStore | undefined {
	const acode = (globalThis as { acode?: { require?: (name: string) => unknown } & Record<string, unknown> }).acode;
	const bag = ctx as (Acode.PluginContext & Record<string, unknown>) | null | undefined;
	const candidates: unknown[] = [
		bag?.kv,
		bag?.db,
		acode?.kv,
		acode?.db,
		requireAcodeModule(acode, "kv"),
		requireAcodeModule(acode, "database"),
	];
	for (const candidate of candidates) {
		if (isKvLike(candidate)) return new HostKvStore(candidate);
	}
	return undefined;
}

export class MemoryKvStore implements KvStore {
	readonly driver = "memory" as const;
	#data = new Map<string, unknown>();

	async get(key: string): Promise<unknown> {
		if (!this.#data.has(key)) return undefined;
		return clone(this.#data.get(key));
	}

	async set(key: string, value: unknown): Promise<void> {
		this.#data.set(key, clone(value));
	}

	async delete(key: string): Promise<void> {
		this.#data.delete(key);
	}

	async keys(): Promise<string[]> {
		return [...this.#data.keys()];
	}
}

export class IndexedDbKvStore implements KvStore {
	readonly driver = "indexeddb" as const;
	#name: string;
	#db?: Promise<IDBDatabase>;

	constructor(name = IDB_NAME) {
		this.#name = name;
	}

	async get(key: string): Promise<unknown> {
		const db = await this.#database();
		return idbRequest(db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key));
	}

	async set(key: string, value: unknown): Promise<void> {
		const db = await this.#database();
		await idbRequest(db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key));
	}

	async delete(key: string): Promise<void> {
		const db = await this.#database();
		await idbRequest(db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(key));
	}

	async keys(): Promise<string[]> {
		const db = await this.#database();
		const store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
		if (typeof store.getAllKeys === "function") {
			return (await idbRequest(store.getAllKeys())).map(String);
		}
		return idbKeys(store);
	}

	#database(): Promise<IDBDatabase> {
		this.#db ??= openIndexedDb(this.#name);
		return this.#db.catch((error) => {
			this.#db = undefined;
			throw error;
		});
	}
}

class HostKvStore implements KvStore {
	readonly driver = "acode" as const;
	#host: HostKv;

	constructor(host: HostKv) {
		this.#host = host;
	}

	async get(key: string): Promise<unknown> {
		const value = await this.#host.get(key);
		if (value == null || value === "") return undefined;
		if (typeof value === "string") {
			try {
				return JSON.parse(value) as unknown;
			} catch {
				return value;
			}
		}
		return value;
	}

	async set(key: string, value: unknown): Promise<void> {
		await this.#host.set(key, JSON.stringify(value));
	}

	async delete(key: string): Promise<void> {
		if (typeof this.#host.delete === "function") await this.#host.delete(key);
		else if (typeof this.#host.remove === "function") await this.#host.remove(key);
		else await this.#host.set(key, "");
	}

	async keys(): Promise<string[]> {
		if (typeof this.#host.keys !== "function") return [];
		return (await this.#host.keys()).map(String);
	}
}

function isKvLike(value: unknown): value is HostKv {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.get === "function" && typeof candidate.set === "function";
}

function requireAcodeModule(acode: { require?: (name: string) => unknown } | undefined, name: string): unknown {
	if (typeof acode?.require !== "function") return undefined;
	try {
		return acode.require(name);
	} catch {
		return undefined;
	}
}

function openIndexedDb(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, IDB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
		request.onblocked = () => reject(new Error("IndexedDB open blocked"));
	});
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function idbKeys(store: IDBObjectStore): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const keys: string[] = [];
		const request = store.openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(keys);
				return;
			}
			keys.push(String(cursor.key));
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
	});
}

function clone<T>(value: T): T {
	if (value === undefined) return value;
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}
