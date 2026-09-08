import { BACKGROUND_CONTEXT as context, JsonlSessionRepo, getOrThrow, value, type FileSystem, type JsonlSessionMetadata, type Session } from "@earendil-works/pi-agent-core";
import { redactedSessionFileSystem } from "./sessionRedaction";
import { privateSessionFileSystem } from "./sessionFileSystem";
export { createChatId, messagePlainText, titleFromEntries, titleFromMessages } from "../session/sessionText";

export type ChatMeta = { id: string; title: string; workspaceId: string; workspaceName: string; updatedAt: number };
export type SessionRecord = ChatMeta & { providerId: string; modelId: string };
export type SessionMetaPatch = Partial<Pick<SessionRecord, "title" | "providerId" | "modelId">>;
const META = value<SessionRecord>("acode", "metadata");
const TASKS = value<unknown>("acode", "tasks");
const CWD = "/acode";

export function createSessionStore(_ctx?: Acode.PluginContext | null): SessionStore { return new SessionStore(); }

/** One repository owner per plugin instance. Pi owns all session transactions. */
export class SessionStore {
	readonly driver = "filesystem" as const;
	#fs?: FileSystem;
	#repo?: JsonlSessionRepo;
	#index = new Map<string, SessionRecord>();
	#metadata = new Map<string, JsonlSessionMetadata>();
	#sessions = new Map<string, Session<JsonlSessionMetadata>>();
	#ready?: Promise<void>;
	constructor(fileSystem?: FileSystem) { this.#fs = fileSystem; }
	list(): ChatMeta[] { return [...this.#index.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((item) => ({ ...item })); }
	load(id: string): ChatMeta | undefined { const item = this.#index.get(id); return item && { ...item }; }
	async hydrate(): Promise<void> {
		this.#ready ??= this.#hydrate().catch((error) => { this.#ready = undefined; throw error; });
		return this.#ready;
	}
	async #hydrate(): Promise<void> {
		this.#fs ??= privateSessionFileSystem();
		this.#repo ??= new JsonlSessionRepo({ fileSystem: redactedSessionFileSystem(this.#fs), sessionsRoot: "/sessions" });
		for (const metadata of await this.#repo.list(undefined, context)) {
			this.#metadata.set(metadata.id, metadata);
			const session = await this.#repo.open(metadata, context);
			try {
				const record = (await session.getValue(META, context))?.value;
				if (record) this.#index.set(metadata.id, { ...record, id: metadata.id, updatedAt: Math.max(record.updatedAt, metadata.modifiedAt) });
			} finally { await session.close(context); }
		}
	}
	async #session(id: string): Promise<Session<JsonlSessionMetadata>> {
		await this.hydrate();
		const existing = this.#sessions.get(id);
		if (existing) return existing;
		const metadata = this.#metadata.get(id);
		if (!metadata) throw new Error(`Unknown chat: ${id}`);
		const session = await this.#repo!.open(metadata, context);
		this.#sessions.set(id, session);
		return session;
	}
	async open(options: { id: string; workspaceId: string; workspaceName?: string; providerId: string; modelId: string; title?: string }) {
		await this.hydrate();
		if (!this.#metadata.has(options.id)) {
			const session = await this.#repo!.create({ id: options.id, cwd: CWD }, context);
			this.#metadata.set(options.id, session.metadata);
			this.#sessions.set(options.id, session);
		}
		const session = await this.#session(options.id);
		const record: SessionRecord = { title: "New chat", workspaceName: "", updatedAt: Date.now(), ...options, ...this.#index.get(options.id) };
		this.#index.set(options.id, record);
		await session.setValue(META, record, context);
		return {
			session, record,
			update: (patch: SessionMetaPatch) => { Object.assign(record, patch, { updatedAt: Date.now() }); },
			persist: async () => { await session.setValue(META, { ...record }, context); },
		};
	}
	async release(id: string): Promise<void> {
		const session = this.#sessions.get(id);
		if (session) { await session.close(context); this.#sessions.delete(id); }
	}
	async remove(id: string): Promise<void> {
		await this.hydrate();
		await this.release(id);
		const metadata = this.#metadata.get(id);
		if (metadata) await this.#repo!.delete(metadata, context);
		this.#metadata.delete(id); this.#index.delete(id);
	}
	async loadTasks(id: string): Promise<unknown> { return (await (await this.#session(id)).getValue(TASKS, context))?.value; }
	async saveTasks(id: string, tasks: unknown): Promise<void> { await (await this.#session(id)).setValue(TASKS, tasks, context); }
	async copyTasks(fromId: string, toId: string): Promise<void> { const tasks = await this.loadTasks(fromId); if (tasks !== undefined) await this.saveTasks(toId, tasks); }
	async fork(fromId: string, options: SessionRecord, targetId?: string, branch = "main", wholeTree = false): Promise<void> {
		await this.hydrate();
		const source = this.#metadata.get(fromId);
		if (!source) throw new Error("Source chat is unavailable");
		const session = await this.#repo!.fork(source, wholeTree ? { scope: "tree", id: options.id } : { scope: "branch", branch, id: options.id, ...(targetId ? { entryId: targetId, position: "before" as const } : {}) }, context);
		this.#metadata.set(options.id, session.metadata); this.#sessions.set(options.id, session);
		this.#index.set(options.id, options);
		await session.setValue(META, options, context);
		await session.setName(options.title, context);
	}
	async export(id: string): Promise<string> {
		await this.hydrate();
		const metadata = this.#metadata.get(id);
		if (!metadata) throw new Error("Chat is unavailable");
		return getOrThrow(await this.#fs!.readTextFile(metadata.path, context));
	}
	/** Pi validates JSONL and converts supported legacy Pi files; no KV migration. */
	async import(text: string, options: SessionRecord): Promise<void> {
		await this.hydrate();
		const temp = getOrThrow(await this.#fs!.createTempDir("import-", context));
		try {
			getOrThrow(await this.#fs!.writeFile(`${temp}/incoming/session.jsonl`, text, context));
			const importer = new JsonlSessionRepo({ fileSystem: this.#fs!, sessionsRoot: temp });
			const candidates = await importer.list(undefined, context);
			if (candidates.length !== 1) throw new Error("Choose a valid Pi JSONL session export.");
			// Give the incoming file a fresh identity before crossing repositories.
			// Otherwise a matching open local ID could shadow the imported file.
			const staged = await importer.fork(candidates[0], { scope: "tree" }, context);
			await staged.close(context);
			const session = await this.#repo!.fork(staged.metadata, { scope: "tree", id: options.id }, context);
			this.#metadata.set(options.id, session.metadata); this.#sessions.set(options.id, session);
			this.#index.set(options.id, options);
			await session.setValue(META, options, context);
			await session.setName(options.title, context);
		} finally { getOrThrow(await this.#fs!.remove(temp, { recursive: true, force: true }, context)); }
	}
}
