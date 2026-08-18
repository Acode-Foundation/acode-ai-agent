import type { AgentMessage, SessionMetadata, SessionStorage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { parseChatIndex, parseStoredChat, parseStoredSession } from "../core/schema";
import { sessionEntriesFromMessages, titleFromEntries, titleFromMessages } from "../session/sessionText";

export { createChatId, messagePlainText, sessionEntriesFromMessages, titleFromEntries, titleFromMessages } from "../session/sessionText";

const INDEX_KEY = "acode.ai-agent.chats.v3";
const SESSION_PREFIX = "acode.ai-agent.session.v3:";
const V2_INDEX_KEY = "acode.ai-agent.chats.v2";
const V2_PREFIX = "acode.ai-agent.chat.v2:";
const LEGACY_PREFIX = "acode.ai-agent.session.v1:";

export type ChatMeta = {
	id: string;
	title: string;
	workspaceId: string;
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

export class BrowserSessionStore {
	list(): ChatMeta[] {
		this.#migrate();
		try {
			return parseChatIndex(JSON.parse(localStorage.getItem(INDEX_KEY) ?? "null"));
		} catch {
			return [];
		}
	}

	load(id: string): Omit<StoredSessionRecord, "entries" | "leafId"> | undefined {
		const record = this.#read(id);
		if (!record) return undefined;
		const { entries: _entries, leafId: _leafId, ...meta } = record;
		return meta;
	}

	open(options: {
		id: string;
		workspaceId: string;
		providerId: string;
		modelId: string;
		title?: string;
	}): {
		session: Session<SessionMetadata>;
		record: Omit<StoredSessionRecord, "entries" | "leafId">;
		update(patch: SessionMetaPatch): void;
		persist(): Promise<void>;
	} {
		this.#migrate();
		const existing = this.#read(options.id);
		const record: Omit<StoredSessionRecord, "entries" | "leafId"> = {
			id: options.id,
			title: existing?.title || options.title || "New chat",
			workspaceId: existing?.workspaceId || options.workspaceId,
			providerId: existing?.providerId || options.providerId,
			modelId: existing?.modelId || options.modelId,
			createdAt: existing?.createdAt || new Date().toISOString(),
			updatedAt: existing?.updatedAt ?? Date.now(),
		};
		const inner = new InMemorySessionStorage({
			entries: existing?.entries ?? [],
			metadata: { id: record.id, createdAt: record.createdAt },
		});
		const persist = async () => {
			const [entries, leafId] = await Promise.all([inner.getEntries(), inner.getLeafId()]);
			this.#write({ ...record, entries, leafId, updatedAt: Date.now() });
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

	remove(id: string): void {
		try {
			localStorage.removeItem(`${SESSION_PREFIX}${id}`);
			localStorage.setItem(INDEX_KEY, JSON.stringify({ chats: this.list().filter((item) => item.id !== id) }));
		} catch {
			// Live chats can continue without storage.
		}
	}

	#read(id: string): StoredSessionRecord | undefined {
		try {
			const parsed = parseStoredSession(JSON.parse(localStorage.getItem(`${SESSION_PREFIX}${id}`) ?? "null"));
			return parsed ? { ...parsed, entries: parsed.entries as SessionTreeEntry[] } : undefined;
		} catch {
			return undefined;
		}
	}

	#write(record: StoredSessionRecord): void {
		const safe = redactDeep({
			...record,
			title: record.title || titleFromEntries(record.entries) || "New chat",
			updatedAt: Date.now(),
		});
		try {
			localStorage.setItem(`${SESSION_PREFIX}${record.id}`, JSON.stringify(safe));
			const index = this.list().filter((item) => item.id !== record.id);
			index.unshift({ id: record.id, title: safe.title, workspaceId: safe.workspaceId, updatedAt: safe.updatedAt });
			localStorage.setItem(INDEX_KEY, JSON.stringify({ chats: index.slice(0, 40) }));
		} catch (error) {
			console.warn("AI session could not be persisted", error);
		}
	}

	#migrate(): void {
		try {
			if (localStorage.getItem(INDEX_KEY)) return;
			const chats: ChatMeta[] = [];
			for (const record of collectLegacySessions()) {
				localStorage.setItem(`${SESSION_PREFIX}${record.id}`, JSON.stringify(record));
				chats.push({ id: record.id, title: record.title, workspaceId: record.workspaceId, updatedAt: record.updatedAt });
			}
			if (chats.length) localStorage.setItem(INDEX_KEY, JSON.stringify({ chats }));
		} catch {
			// Ignore corrupt legacy records.
		}
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
	const v2Index = parseChatIndex(JSON.parse(localStorage.getItem(V2_INDEX_KEY) ?? "null"));
	const seen = new Set<string>();
	for (const meta of v2Index) {
		const parsed = parseStoredChat(JSON.parse(localStorage.getItem(`${V2_PREFIX}${meta.id}`) ?? "null"));
		if (!parsed) continue;
		seen.add(parsed.id);
		records.push(recordFromMessages({ ...parsed, messages: parsed.messages as AgentMessage[] }));
	}
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (!key?.startsWith(LEGACY_PREFIX)) continue;
		const raw = JSON.parse(localStorage.getItem(key) ?? "null") as {
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
		providerId: chat.providerId,
		modelId: chat.modelId,
		createdAt: new Date(chat.updatedAt).toISOString(),
		updatedAt: chat.updatedAt,
		leafId: entries.at(-1)?.id ?? null,
		entries,
	};
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
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/(?:api.?key|authorization|access.?token|refresh.?token|password|passphrase|secret|credential)/i.test(key)
					? "[REDACTED_SECRET]"
					: redactDeep(item),
			]),
		) as T;
	}
	return value;
}


