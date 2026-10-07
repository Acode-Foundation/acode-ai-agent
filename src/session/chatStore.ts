import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import {
  CHATS,
  IdbFileSystem,
  idbRequest,
  idbTransaction,
  openAgentDatabase,
} from "../platform/idbFileSystem";
import { redactingFileSystem } from "../platform/secretRedaction";

/** Index row for one chat. The transcript itself lives in the chat's own Pi storage. */
export type ChatMeta = {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  createdAt: number;
  updatedAt: number;
  /** Pi conversation the chat shows; other conversations are branches made from /tree. */
  conversationId?: number;
};

/**
 * Chats persist in IndexedDB. Each chat is one Pi durable Session over `JsonlStorage`,
 * whose append-only files live in an IndexedDB-backed file tree, so a chat is deleted by
 * removing its folder. A small index keeps the chat list without opening every chat.
 */
export class ChatStore {
  readonly fs: IdbFileSystem;
  #db: Promise<IDBDatabase>;
  #index = new Map<string, ChatMeta>();
  #ready?: Promise<void>;

  constructor(db: Promise<IDBDatabase> = openAgentDatabase()) {
    this.#db = db;
    // Surface a failed open once, from hydrate(), not as an unhandled rejection.
    db.catch(() => undefined);
    this.fs = new IdbFileSystem(db);
  }

  hydrate(): Promise<void> {
    this.#ready ??= this.#load().catch((error) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  list(): ChatMeta[] {
    return [...this.#index.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => ({ ...item }));
  }

  get(id: string): ChatMeta | undefined {
    const item = this.#index.get(id);
    return item && { ...item };
  }

  async save(meta: ChatMeta): Promise<void> {
    await this.hydrate();
    this.#index.set(meta.id, { ...meta });
    await idbTransaction(await this.#db, [CHATS], "readwrite", async (tx) => {
      await idbRequest(tx.objectStore(CHATS).put({ ...meta }));
    });
  }

  async update(id: string, patch: Partial<Omit<ChatMeta, "id">>): Promise<ChatMeta | undefined> {
    await this.hydrate();
    const current = this.#index.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.save(next);
    return next;
  }

  /** Open the chat's Pi storage, creating it on first use. One owner at a time. */
  async openStorage(id: string): Promise<Storage> {
    return JsonlStorage.open(chatDirectory(id), redactingFileSystem(this.fs), context);
  }

  async remove(id: string): Promise<void> {
    await this.hydrate();
    getOrThrow(await this.fs.remove(chatDirectory(id), { recursive: true, force: true }, context));
    this.#index.delete(id);
    await idbTransaction(await this.#db, [CHATS], "readwrite", async (tx) => {
      await idbRequest(tx.objectStore(CHATS).delete(id));
    });
  }

  async #load(): Promise<void> {
    const rows = await idbTransaction(await this.#db, [CHATS], "readonly", (tx) =>
      idbRequest(tx.objectStore(CHATS).getAll() as IDBRequest<ChatMeta[]>),
    );
    this.#index = new Map(rows.map((row) => [row.id, row]));
  }
}

function chatDirectory(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
  return `/chats/${id}`;
}

export function createChatId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}
