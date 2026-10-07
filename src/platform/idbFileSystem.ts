import type { Context } from "@earendil-works/chord";
import {
  err,
  FileError,
  ok,
  type FileErrorCode,
  type FileInfo,
  type FileSystem,
  type Result,
} from "@earendil-works/pi-durable/env";

/** One database holds every chat: a small virtual file tree plus the chat index. */
export const AGENT_DB_NAME = "acode-ai-agent-chats";
const DB_VERSION = 1;
const NODES = "nodes";
const CHUNKS = "chunks";
export const CHATS = "chats";

type NodeRecord = {
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  /** Appended chunks stored under `[path, 0..chunks)`; merged on read. */
  chunks: number;
};

export function openAgentDatabase(name = AGENT_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable. Chats cannot be persisted."));
      return;
    }
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(NODES)) db.createObjectStore(NODES, { keyPath: "path" });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      if (!db.objectStoreNames.contains(CHATS)) db.createObjectStore(CHATS, { keyPath: "id" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
    open.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab."));
  });
}

export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

/** Run `body` in one transaction and resolve with its value once the transaction commits. */
export async function idbTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
  });
  let value: T;
  try {
    value = await body(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished.
    }
    await committed.catch(() => undefined);
    throw error;
  }
  await committed;
  return value;
}

/**
 * Pi's portable `FileSystem` over IndexedDB, for `JsonlStorage`. Only the operations a
 * JSONL session store needs are implemented: path handling, directories, whole-file
 * reads, writes, appends, truncation, and renames. Appends add a chunk record instead of
 * rewriting the file; reads merge a file's chunks back into one.
 */
export class IdbFileSystem implements FileSystem {
  readonly id = `idb:${AGENT_DB_NAME}`;
  cwd = "/";
  #db: Promise<IDBDatabase>;

  constructor(db: Promise<IDBDatabase>) {
    this.#db = db;
  }

  absolutePath(path: string, _context: Context) {
    return this.#result(path, async () => normalize(path));
  }

  joinPath(parts: string[], _context: Context) {
    return this.#result(parts.join("/"), async () => normalize(parts.join("/")));
  }

  canonicalPath(path: string, context: Context) {
    return this.#result(path, async () => {
      const info = await this.fileInfo(path, context);
      if (!info.ok) throw info.error;
      return info.value.path;
    });
  }

  readBinaryFile(path: string, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES, CHUNKS], "readwrite", async (tx) => {
        const target = normalize(path);
        const node = await this.#node(tx, target);
        if (!node) throw new FileError("not_found", `No such file: ${target}`, target);
        if (node.kind !== "file")
          throw new FileError("is_directory", `${target} is a folder`, target);
        const bytes = concat(await readChunks(tx, target));
        // Merge appended chunks so the next read is one record.
        if (node.chunks > 1) await replaceContent(tx, node, bytes);
        return bytes;
      }),
    );
  }

  readTextFile(path: string, context: Context) {
    return this.#result(path, async () => {
      const bytes = await this.readBinaryFile(path, context);
      if (!bytes.ok) throw bytes.error;
      return new TextDecoder().decode(bytes.value);
    });
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.#result(path, async () => {
      const text = await this.readTextFile(path, context);
      if (!text.ok) throw text.error;
      return text.value.split(/\r?\n/).slice(0, options?.maxLines);
    });
  }

  writeFile(path: string, content: string | Uint8Array, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES, CHUNKS], "readwrite", async (tx) => {
        const node = await this.#fileForWrite(tx, normalize(path));
        await replaceContent(tx, node, toBytes(content));
      }),
    );
  }

  appendFile(path: string, content: string | Uint8Array, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES, CHUNKS], "readwrite", async (tx) => {
        const node = await this.#fileForWrite(tx, normalize(path));
        const bytes = toBytes(content);
        if (!bytes.length) return;
        await idbRequest(tx.objectStore(CHUNKS).put(bytes, [node.path, node.chunks]));
        await putNode(tx, {
          ...node,
          chunks: node.chunks + 1,
          size: node.size + bytes.length,
          mtimeMs: Date.now(),
        });
      }),
    );
  }

  truncateFile(path: string, size: number, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES, CHUNKS], "readwrite", async (tx) => {
        const target = normalize(path);
        const node = await this.#node(tx, target);
        if (!node) throw new FileError("not_found", `No such file: ${target}`, target);
        if (node.kind !== "file")
          throw new FileError("is_directory", `${target} is a folder`, target);
        const bytes = concat(await readChunks(tx, target));
        const next = new Uint8Array(Math.max(0, size));
        next.set(bytes.subarray(0, Math.min(bytes.length, next.length)));
        await replaceContent(tx, node, next);
      }),
    );
  }

  async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
    // Each write is its own committed IndexedDB transaction.
    return ok(undefined);
  }

  renameFile(source: string, destination: string, _context: Context) {
    return this.#result(source, () =>
      this.#run([NODES, CHUNKS], "readwrite", async (tx) => {
        const from = normalize(source);
        const to = normalize(destination);
        if (from === to) return;
        const node = await this.#node(tx, from);
        if (!node) throw new FileError("not_found", `No such file: ${from}`, from);
        if (node.kind !== "file")
          throw new FileError("not_supported", "Only files can be renamed", from);
        const bytes = concat(await readChunks(tx, from));
        const target = await this.#fileForWrite(tx, to);
        await replaceContent(tx, target, bytes);
        await deleteChunks(tx, from);
        await idbRequest(tx.objectStore(NODES).delete(from));
      }),
    );
  }

  fileInfo(path: string, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES], "readonly", async (tx) => {
        const target = normalize(path);
        const node = await this.#node(tx, target);
        if (!node) throw new FileError("not_found", `No such file: ${target}`, target);
        return toInfo(node);
      }),
    );
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : err(info.error);
  }

  listDir(path: string, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES], "readonly", async (tx) => {
        const target = normalize(path);
        const node = await this.#node(tx, target);
        if (!node) throw new FileError("not_found", `No such folder: ${target}`, target);
        if (node.kind !== "directory")
          throw new FileError("not_directory", `${target} is not a folder`, target);
        const prefix = target === "/" ? "/" : `${target}/`;
        const nodes = (await idbRequest(
          tx.objectStore(NODES).getAll(prefixRange(prefix)),
        )) as NodeRecord[];
        return nodes.filter((item) => !item.path.slice(prefix.length).includes("/")).map(toInfo);
      }),
    );
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, _context: Context) {
    return this.#result(path, () =>
      this.#run([NODES], "readwrite", async (tx) => {
        const target = normalize(path);
        const parts = target.split("/").filter(Boolean);
        for (let index = 1; index <= parts.length; index += 1) {
          const current = `/${parts.slice(0, index).join("/")}`;
          const node = await this.#node(tx, current);
          if (node?.kind === "directory") continue;
          if (node) throw new FileError("not_directory", `${current} is a file`, current);
          if (index < parts.length && options?.recursive === false)
            throw new FileError("not_found", `No such folder: ${current}`, current);
          await putNode(tx, {
            path: current,
            kind: "directory",
            size: 0,
            mtimeMs: Date.now(),
            chunks: 0,
          });
        }
      }),
    );
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    _context: Context,
  ) {
    return this.#result(path, () =>
      this.#run([NODES, CHUNKS], "readwrite", async (tx) => {
        const target = normalize(path);
        if (target === "/")
          throw new FileError("permission_denied", "Cannot remove the root", target);
        const node = await this.#node(tx, target);
        if (!node) {
          if (options?.force) return;
          throw new FileError("not_found", `No such file: ${target}`, target);
        }
        if (node.kind === "directory") {
          const range = prefixRange(`${target}/`);
          const children = await idbRequest(tx.objectStore(NODES).getAllKeys(range));
          if (children.length && !options?.recursive)
            throw new FileError("invalid", "Directory is not empty", target);
          await idbRequest(tx.objectStore(NODES).delete(range));
          await idbRequest(
            tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([`${target}/`], [`${target}/￿`])),
          );
        } else {
          await deleteChunks(tx, target);
        }
        await idbRequest(tx.objectStore(NODES).delete(target));
      }),
    );
  }

  openTextLineReader(path: string) {
    return unsupported<never>(path);
  }
  openBinaryReader(path: string) {
    return unsupported<never>(path);
  }
  openDirReader(path: string) {
    return unsupported<never>(path);
  }
  watch() {
    return unsupported<never>("");
  }
  createTempDir() {
    return unsupported<string>("");
  }
  createTempFile() {
    return unsupported<string>("");
  }
  async cleanup(): Promise<void> {}

  async #run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    return idbTransaction(await this.#db, stores, mode, body);
  }

  async #node(tx: IDBTransaction, path: string): Promise<NodeRecord | undefined> {
    if (path === "/") return { path, kind: "directory", size: 0, mtimeMs: 0, chunks: 0 };
    return (await idbRequest(tx.objectStore(NODES).get(path))) as NodeRecord | undefined;
  }

  async #fileForWrite(tx: IDBTransaction, path: string): Promise<NodeRecord> {
    if (path === "/") throw new FileError("is_directory", "The root is a folder", path);
    const node = await this.#node(tx, path);
    if (node?.kind === "directory")
      throw new FileError("is_directory", `${path} is a folder`, path);
    if (node) return node;
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const folder = await this.#node(tx, parent);
    if (!folder) throw new FileError("not_found", `No such folder: ${parent}`, parent);
    if (folder.kind !== "directory")
      throw new FileError("not_directory", `${parent} is not a folder`, parent);
    return { path, kind: "file", size: 0, mtimeMs: Date.now(), chunks: 0 };
  }

  async #result<T>(path: string, run: () => Promise<T>): Promise<Result<T, FileError>> {
    try {
      return ok(await run());
    } catch (error) {
      if (error instanceof FileError) return err(error);
      return err(
        new FileError(
          "unknown",
          error instanceof Error ? error.message : String(error),
          path,
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

/** POSIX-style absolute path; rejects traversal and URL schemes. */
function normalize(path: string): string {
  if (path.includes("\0") || path.includes("\\") || /^[a-z][a-z\d+.-]*:/i.test(path))
    throw new FileError("invalid", "Invalid storage path", path);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new FileError("permission_denied", "Path escapes storage", path);
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
}

function chunkRange(path: string): IDBKeyRange {
  return IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]);
}

async function readChunks(tx: IDBTransaction, path: string): Promise<Uint8Array[]> {
  const values = await idbRequest(tx.objectStore(CHUNKS).getAll(chunkRange(path)));
  return values.map((value) =>
    value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer),
  );
}

async function deleteChunks(tx: IDBTransaction, path: string): Promise<void> {
  await idbRequest(tx.objectStore(CHUNKS).delete(chunkRange(path)));
}

async function replaceContent(
  tx: IDBTransaction,
  node: NodeRecord,
  bytes: Uint8Array,
): Promise<void> {
  await deleteChunks(tx, node.path);
  if (bytes.length) await idbRequest(tx.objectStore(CHUNKS).put(bytes, [node.path, 0]));
  await putNode(tx, {
    ...node,
    chunks: bytes.length ? 1 : 0,
    size: bytes.length,
    mtimeMs: Date.now(),
  });
}

async function putNode(tx: IDBTransaction, node: NodeRecord): Promise<void> {
  await idbRequest(tx.objectStore(NODES).put(node));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
}

function toInfo(node: NodeRecord): FileInfo {
  return {
    name: node.path.split("/").at(-1) ?? "",
    path: node.path,
    kind: node.kind,
    size: node.size,
    mtimeMs: node.mtimeMs,
  };
}

async function unsupported<T>(path: string): Promise<Result<T, FileError>> {
  return err(
    new FileError("not_supported" satisfies FileErrorCode, "Not supported by chat storage", path),
  );
}
