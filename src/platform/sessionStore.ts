import type { AgentMessage, SessionMetadata, SessionStorage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { parseChatIndex, parseStoredChat, parseStoredSession } from "../core/schema";
import { sessionEntriesFromMessages, titleFromEntries, titleFromMessages } from "../session/sessionText";
import { createKvStore, MemoryKvStore, type KvStore } from "./kvStore";

export { createChatId, messagePlainText, sessionEntriesFromMessages, titleFromEntries, titleFromMessages } from "../session/sessionText";

const INDEX_KEY = "acode.ai-agent.chats.v3";
const SESSION_PREFIX = "acode.ai-agent.session.v3:";
const V2_INDEX_KEY = "acode.ai-agent.chats.v2";
const V2_PREFIX = "acode.ai-agent.chat.v2:";
const LEGACY_PREFIX = "acode.ai-agent.session.v1:";
const INDEX_LIMIT = 40;

export type ChatMeta = {
	id: string;
	title: string;
	workspaceId: string;
	workspaceName: string;
	updatedAt: number;
};

export type StoredSessionRecord = ChatMeta & {
	providerId: string;
	modelId: string;
	createdAt: string;
	leafId: string | null;
	entries: SessionTreeEntry[];
};

export type SessionMetaPatch = Partial<Pick<StoredSessionRecord, "title" | "providerId" | "modelId">>;

export function createSessionStore(ctx?: Acode.PluginContext | null): SessionStore {
	return new SessionStore(createKvStore(ctx));
}

export class SessionStore {
	#kv: KvStore;
	#index: ChatMeta[] = [];
	#ready?: Promise<void>;
	#queue: Promise<void> = Promise.resolve();

	constructor(kv: KvStore = new MemoryKvStore()) {
		this.#kv = kv;
	}

	get driver(): KvStore["driver"] {
		return this.#kv.driver;
	}

	list(): ChatMeta[] {
		return this.#index.map((item) => ({ ...item }));
	}

	load(id: string): ChatMeta | undefined {
		const item = this.#index.find((chat) => chat.id === id);
		return item ? { ...item } : undefined;
	}

	async hydrate(): Promise<void> {
		this.#ready ??= this.#hydrate().catch((error) => {
			this.#kv = new MemoryKvStore();
			this.#index = [];
			console.warn("AI session storage failed; chats will not persist", error);
		});
		await this.#ready;
	}

	async open(options: {
		id: string;
		workspaceId: string;
		workspaceName?: string;
		providerId: string;
		modelId: string;
		title?: string;
	}): Promise<{
		session: Session<SessionMetadata>;
		record: Omit<StoredSessionRecord, "entries" | "leafId">;
		update(patch: SessionMetaPatch): void;
		persist(): Promise<void>;
	}> {
		await this.hydrate();
		const existing = await this.#read(options.id);
		const record: Omit<StoredSessionRecord, "entries" | "leafId"> = {
			id: options.id,
			title: existing?.title || options.title || "New chat",
			workspaceId: existing?.workspaceId || options.workspaceId,
			workspaceName: options.workspaceName || existing?.workspaceName || "",
			providerId: existing?.providerId || options.providerId,
			modelId: existing?.modelId || options.modelId,
			createdAt: existing?.createdAt || new Date().toISOString(),
			updatedAt: existing?.updatedAt ?? Date.now(),
		};
		this.#upsertIndex(record);
		const inner = new InMemorySessionStorage({
			entries: existing?.entries ?? [],
			metadata: { id: record.id, createdAt: record.createdAt },
		});
		const persist = async () => {
			const [entries, leafId] = await Promise.all([inner.getEntries(), inner.getLeafId()]);
			await this.#write({ ...record, entries, leafId, updatedAt: Date.now() });
		};
		let flush = Promise.resolve();
		const schedule = () => {
			flush = flush.then(persist, persist);
		};
		const storage = new PersistedSessionStorage(inner, schedule);
		return {
			session: new Session(storage),
			record,
			update(patch) {
				if (patch.title !== undefined) record.title = patch.title || record.title;
				if (patch.providerId) record.providerId = patch.providerId;
				if (patch.modelId) record.modelId = patch.modelId;
				schedule();
			},
			persist() {
				return flush.then(persist, persist);
			},
		};
	}

	async remove(id: string): Promise<void> {
		await this.hydrate();
		this.#index = this.#index.filter((item) => item.id !== id);
		await this.#enqueue(async () => {
			await this.#kv.delete(`${SESSION_PREFIX}${id}`);
			await this.#kv.set(INDEX_KEY, { chats: this.#index });
		});
	}

	async seed(options: {
		id: string;
		title: string;
		workspaceId: string;
		workspaceName: string;
		providerId: string;
		modelId: string;
		entries: SessionTreeEntry[];
	}): Promise<void> {
		await this.hydrate();
		const now = Date.now();
		await this.#write({
			...options,
			createdAt: new Date(now).toISOString(),
			updatedAt: now,
			leafId: options.entries.at(-1)?.id ?? null,
			entries: [...options.entries],
		});
	}

	async #hydrate(): Promise<void> {
		await this.#migrate();
		this.#index = parseChatIndex(await this.#kv.get(INDEX_KEY));
	}

	async #read(id: string): Promise<StoredSessionRecord | undefined> {
		try {
			const parsed = parseStoredSession(await this.#kv.get(`${SESSION_PREFIX}${id}`));
			return parsed ? { ...parsed, entries: parsed.entries as SessionTreeEntry[] } : undefined;
		} catch {
			return undefined;
		}
	}

	async #write(record: StoredSessionRecord): Promise<void> {
		const safe = redactDeep({
			...record,
			title: record.title || titleFromEntries(record.entries) || "New chat",
			updatedAt: Date.now(),
		});
		this.#upsertIndex(safe);
		try {
			await this.#enqueue(async () => {
				await this.#kv.set(`${SESSION_PREFIX}${record.id}`, safe);
				await this.#kv.set(INDEX_KEY, { chats: this.#index.slice(0, INDEX_LIMIT) });
			});
		} catch (error) {
			console.warn("AI session could not be persisted", error);
		}
	}

	#upsertIndex(record: Pick<StoredSessionRecord, "id" | "title" | "workspaceId" | "workspaceName" | "updatedAt">): void {
		const next: ChatMeta = {
			id: record.id,
			title: record.title || "New chat",
			workspaceId: record.workspaceId,
			workspaceName: record.workspaceName || "",
			updatedAt: record.updatedAt,
		};
		this.#index = [next, ...this.#index.filter((item) => item.id !== record.id)].slice(0, INDEX_LIMIT);
	}

	async #migrate(): Promise<void> {
		const existing = parseChatIndex(await this.#kv.get(INDEX_KEY));
		if (existing.length) {
			this.#index = existing;
			return;
		}
		const records = collectLegacySessions();
		if (!records.length) return;
		const chats: ChatMeta[] = [];
		for (const record of records) {
			await this.#kv.set(`${SESSION_PREFIX}${record.id}`, record);
			chats.push({ id: record.id, title: record.title, workspaceId: record.workspaceId, workspaceName: record.workspaceName || "", updatedAt: record.updatedAt });
		}
		this.#index = chats;
		await this.#kv.set(INDEX_KEY, { chats });
		clearLegacyLocalStorage();
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		this.#queue = this.#queue.then(task, task);
		return this.#queue;
	}
}

class PersistedSessionStorage implements SessionStorage<SessionMetadata> {
	#inner: InMemorySessionStorage<SessionMetadata>;
	#onChange: () => void;

	constructor(inner: InMemorySessionStorage<SessionMetadata>, onChange: () => void) {
		this.#inner = inner;
		this.#onChange = onChange;
	}

	getMetadata() { return this.#inner.getMetadata(); }
	getLeafId() { return this.#inner.getLeafId(); }
	createEntryId() { return this.#inner.createEntryId(); }
	getEntry(id: string) { return this.#inner.getEntry(id); }
	findEntries<TType extends SessionTreeEntry["type"]>(type: TType) { return this.#inner.findEntries(type); }
	getLabel(id: string) { return this.#inner.getLabel(id); }
	getSessionName() { return this.#inner.getSessionName(); }
	getSessionStats() { return this.#inner.getSessionStats(); }
	getPathToRootOrCompaction(leafId: string | null) { return this.#inner.getPathToRootOrCompaction(leafId); }
	getEntries(options?: Parameters<SessionStorage["getEntries"]>[0]) { return this.#inner.getEntries(options); }

	async setLeafId(leafId: string | null): Promise<void> {
		await this.#inner.setLeafId(leafId);
		this.#onChange();
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.#inner.appendEntry(entry);
		this.#onChange();
	}
}

function collectLegacySessions(): StoredSessionRecord[] {
	const records: StoredSessionRecord[] = [];
	const v3Index = parseChatIndex(readLocalJson(INDEX_KEY));
	const seen = new Set<string>();
	for (const meta of v3Index) {
		const parsed = parseStoredSession(readLocalJson(`${SESSION_PREFIX}${meta.id}`));
		if (!parsed) continue;
		seen.add(parsed.id);
		records.push({ ...parsed, entries: parsed.entries as SessionTreeEntry[] });
	}
	const v2Index = parseChatIndex(readLocalJson(V2_INDEX_KEY));
	for (const meta of v2Index) {
		const parsed = parseStoredChat(readLocalJson(`${V2_PREFIX}${meta.id}`));
		if (!parsed || seen.has(parsed.id)) continue;
		seen.add(parsed.id);
		records.push(recordFromMessages({ ...parsed, messages: parsed.messages as AgentMessage[] }));
	}
	const storage = localStorageOrNull();
	if (!storage) return records;
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key?.startsWith(LEGACY_PREFIX)) continue;
		const raw = readLocalJson(key) as {
			workspaceId?: string;
			providerId?: string;
			modelId?: string;
			messages?: AgentMessage[];
			updatedAt?: number;
		} | null;
		if (!raw?.workspaceId) continue;
		const id = `legacy-${raw.workspaceId}`;
		if (seen.has(id)) continue;
		records.push(recordFromMessages({
			id,
			title: titleFromMessages(raw.messages ?? []) || "Imported chat",
			workspaceId: raw.workspaceId,
			providerId: raw.providerId ?? "openrouter",
			modelId: raw.modelId ?? "",
			messages: raw.messages ?? [],
			updatedAt: raw.updatedAt ?? Date.now(),
		}));
	}
	return records;
}

function recordFromMessages(chat: {
	id: string;
	title: string;
	workspaceId: string;
	providerId: string;
	modelId: string;
	messages: AgentMessage[];
	updatedAt: number;
}): StoredSessionRecord {
	const entries = sessionEntriesFromMessages(chat.messages);
	return {
		id: chat.id,
		title: chat.title || titleFromMessages(chat.messages) || "Imported chat",
		workspaceId: chat.workspaceId,
		workspaceName: "",
		providerId: chat.providerId,
		modelId: chat.modelId,
		createdAt: new Date(chat.updatedAt).toISOString(),
		updatedAt: chat.updatedAt,
		leafId: entries.at(-1)?.id ?? null,
		entries,
	};
}

function clearLegacyLocalStorage(): void {
	const storage = localStorageOrNull();
	if (!storage) return;
	const keys: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key) continue;
		if (
			key === INDEX_KEY
			|| key === V2_INDEX_KEY
			|| key.startsWith(SESSION_PREFIX)
			|| key.startsWith(V2_PREFIX)
			|| key.startsWith(LEGACY_PREFIX)
		) {
			keys.push(key);
		}
	}
	for (const key of keys) {
		try {
			storage.removeItem(key);
		} catch {
			// Ignore quota or private-mode failures.
		}
	}
}

function readLocalJson(key: string): unknown {
	const storage = localStorageOrNull();
	if (!storage) return null;
	try {
		return JSON.parse(storage.getItem(key) ?? "null");
	} catch {
		return null;
	}
}

function localStorageOrNull(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function redact(text: string): string {
	return text
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]")
		.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
		.replace(/\b(or-[A-Za-z0-9_-]{12,})\b/gi, "[REDACTED_API_KEY]")
		.replace(/\b(gsk_[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
		.replace(/\b(xai-[A-Za-z0-9_-]{12,})\b/gi, "[REDACTED_API_KEY]")
		.replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]");
}

function redactDeep<T>(value: T): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map(redactDeep) as T;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") {
			return {
				...record,
				mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/jpeg",
				data: record.data,
			} as T;
		}
		return Object.fromEntries(
			Object.entries(record).map(([key, item]) => [
				key,
				/(?:api.?key|authorization|access.?token|refresh.?token|password|passphrase|secret|credential)/i.test(key)
					? "[REDACTED_SECRET]"
					: redactDeep(item),
			]),
		) as T;
	}
	return value;
}
