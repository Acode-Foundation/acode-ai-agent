import type { WorkspaceInfo } from "../core/types";
import { PathSandbox, sameParentUri, workspaceId, workspaceRelativeFromIndex } from "./pathSandbox";

export { getAvailableWorkspaces } from "./sidebarFolders";

export type FileEntry = {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
};

export type WalkOptions = {
  path?: string;
  /** Stop after delivering this many files to `onEntry`. */
  maxFiles: number;
  /** Stop after looking at this many files in total, delivered or not. */
  maxScanned?: number;
  maxDepth?: number;
  /** Files rejected here are neither delivered, skipped nor counted against `maxFiles`. */
  filter?: (entry: FileEntry) => boolean;
  /** Pass over this many accepted files before delivering any (resume a previous walk). */
  skip?: number;
  signal?: AbortSignal;
  onEntry: (entry: FileEntry) => boolean | void | Promise<boolean | void>;
};

export type WalkResult = {
  /** Files delivered to `onEntry`. */
  visited: number;
  /** Accepted files passed over because of `skip`. */
  skipped: number;
  /** Files looked at, including filtered and skipped ones. */
  scanned: number;
  /** Some files were left unvisited. */
  truncated: boolean;
  /** Why the walk ended early: `onEntry` asked to stop, or one of the limits was hit. */
  stop?: "callback" | "file-limit" | "scan-limit";
  /** Where files came from. The index omits hidden paths and Acode's excluded folders. */
  source: "index" | "filesystem";
  /** Workspace-relative folders the disk walk skipped as noise (node_modules, dist, …). */
  skippedFolders: string[];
};

const FS_TIMEOUT_MS = 30_000;
const REMOTE_FS_TIMEOUT_MS = 90_000;

export class NotDirectoryError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path} is a file, not a directory. Use read_file to read it.`);
    this.name = "NotDirectoryError";
    this.path = path;
  }
}

export class AcodeWorkspace {
  readonly info: WorkspaceInfo;
  readonly sandbox: PathSandbox;
  #fileLocks = new Map<string, Promise<unknown>>();

  constructor(rootUri: string, name: string) {
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(rootUri)?.[1]?.toLowerCase() ?? "file";
    this.info = {
      id: workspaceId(rootUri),
      name,
      rootUri,
      scheme,
      remote: scheme === "ftp" || scheme === "sftp",
    };
    this.sandbox = new PathSandbox(rootUri, (root, path) => acode.joinUrl(root, path));
  }

  async readText(path: string): Promise<string> {
    const { uri } = this.sandbox.resolve(path);
    const openFile = editorManager.getFile(uri, "uri");
    if (openFile?.loaded) return openFile.session.getValue();
    return acode.fsOperation(uri).readFile("utf-8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const { uri } = this.sandbox.resolve(path);
    const buffer = await acode.fsOperation(uri).readFile();
    return new Uint8Array(buffer);
  }

  async writeText(path: string, content: string): Promise<"buffer" | "disk"> {
    const { relativePath, uri } = this.sandbox.resolve(path);
    if (!relativePath) throw new Error("A file path is required.");
    return this.#serialize(uri, async () => {
      const openFile = editorManager.getFile(uri, "uri");
      if (openFile?.loaded) {
        if (openFile.readOnly) throw new Error(`${relativePath} is read-only.`);
        if (editorManager.activeFile?.id === openFile.id) {
          const editor = editorManager.editor;
          editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } });
        } else {
          openFile.session.setValue(content);
        }
        openFile.isUnsaved = true;
        openFile.markChanged = true;
        editorManager.emit("file-content-changed", openFile);
        return "buffer";
      }

      const target = acode.fsOperation(uri);
      if (await target.exists()) {
        await target.writeFile(content);
      } else {
        const slash = relativePath.lastIndexOf("/");
        const parentPath = slash >= 0 ? relativePath.slice(0, slash) : "";
        const filename = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
        await this.#ensureDirectory(parentPath);
        const parent = this.sandbox.resolve(parentPath).uri;
        await acode.fsOperation(parent).createFile(filename, content);
      }
      return "disk";
    });
  }

  /**
   * List one directory. The filesystem is authoritative: it shows hidden files and fresh
   * writes the index has not seen. Throws {@link NotDirectoryError} for a file path.
   */
  async list(path = "", signal?: AbortSignal): Promise<FileEntry[]> {
    const base = this.sandbox.resolve(path);
    if (base.relativePath && !(await this.#statDirectory(base.relativePath, signal)))
      throw new NotDirectoryError(base.relativePath);
    return this.#listViaFs(base, signal);
  }

  async stat(path: string, signal?: AbortSignal): Promise<Acode.Stat> {
    const { relativePath, uri } = this.sandbox.resolve(path);
    return this.#settle(
      acode.fsOperation(uri).stat(),
      `Reading ${relativePath || "the workspace root"}`,
      signal,
    );
  }

  /** Whether `path` is a folder; rejects when it does not exist. */
  async #statDirectory(path: string, signal?: AbortSignal): Promise<boolean> {
    const stat = await this.stat(path, signal);
    return !(stat?.isFile === true || stat?.isDirectory === false);
  }

  /**
   * Some Acode providers never settle: internalFs `lsDir` on a file throws `createReader is not
   * a function` inside a Cordova callback, leaving its promise pending. Bound every call.
   */
  #settle<T>(promise: Promise<T>, action: string, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const timeoutMs = this.info.remote ? REMOTE_FS_TIMEOUT_MS : FS_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Operation aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${action} did not finish within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  /**
   * Visit files under `path` in a stable order (index order, or sorted breadth-first on disk).
   * `filter` rejects files without counting them, `skip` passes over the first matching files so
   * callers can resume a previous walk, and `truncated` is only set when files were left unvisited.
   */
  async walk(options: WalkOptions): Promise<WalkResult> {
    const base = options.path ?? "";
    const visitor = new WalkVisitor(options);
    const indexed = await this.#walkIndexed(base, visitor, options.signal);
    if (indexed) return indexed;
    const skippedFolders: string[] = [];

    const maxDepth = options.maxDepth ?? 16;
    if (base && !(await this.#statDirectory(base, options.signal))) {
      await visitor.visit({
        path: base,
        name: base.split("/").pop() ?? base,
        isFile: true,
        isDirectory: false,
      });
      return visitor.result(false, "filesystem");
    }
    const entries = await this.#listViaFs(this.sandbox.resolve(base), options.signal);

    const queue: Array<{ path: string; depth: number; entries?: FileEntry[] }> = [
      { path: base, depth: 0, entries },
    ];
    while (queue.length) {
      throwIfAborted(options.signal);
      const current = queue.shift()!;
      let children = current.entries;
      if (!children) {
        try {
          children = await this.#listViaFs(this.sandbox.resolve(current.path), options.signal);
        } catch {
          // Unreadable folders are skipped; the rest of the tree is still walked.
          continue;
        }
      }
      for (const entry of sortEntries(children)) {
        if (isIgnored(entry.path, base)) {
          if (entry.isDirectory) skippedFolders.push(entry.path);
          continue;
        }
        if (entry.isDirectory && current.depth < maxDepth) {
          queue.push({ path: entry.path, depth: current.depth + 1 });
        }
        if (!entry.isFile) continue;
        if (await visitor.visit(entry)) return visitor.result(true, "filesystem", skippedFolders);
      }
    }
    return visitor.result(false, "filesystem", skippedFolders);
  }

  /** Number of indexed files under `path`, or `undefined` when the native index is unavailable. */
  async indexedFileCount(path = ""): Promise<number | undefined> {
    const index = nativeFileIndex();
    if (!index?.supports(this.info.rootUri)) return undefined;
    try {
      await index.whenReady([this.info.rootUri]);
      const { entries } = await queryIndexedFiles(index, this.info.rootUri, false);
      return entries.filter((item) => {
        const entry = this.#fromIndex(item);
        return entry.isFile && inScope(entry.path, path) && !isIgnored(entry.path, path);
      }).length;
    } catch {
      return undefined;
    }
  }

  async #listViaFs(
    base: { relativePath: string; uri: string },
    signal?: AbortSignal,
  ): Promise<FileEntry[]> {
    const label = base.relativePath || "the workspace root";
    const fs = acode.fsOperation(base.uri);
    if (!fs || typeof fs.lsDir !== "function") throw new Error(`Cannot list ${label}.`);
    try {
      const entries = await this.#settle(fs.lsDir(), `Listing ${label}`, signal);
      return entries.map((entry) => ({
        path: [base.relativePath, entry.name].filter(Boolean).join("/"),
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
      }));
    } catch (error) {
      if (!isMissingDirectoryReader(error)) throw error;
      // Never force a rescan here: re-indexing a whole workspace to list one folder stalls the tool.
      const indexed = await this.#listIndexedChildren(base.uri);
      if (indexed) return indexed;
      throw new Error(`Cannot list ${label} with Acode's folder APIs.`);
    }
  }

  async #listIndexedChildren(parentUri: string, rescan = false): Promise<FileEntry[] | undefined> {
    const index = nativeFileIndex();
    if (!index?.supports(this.info.rootUri)) return undefined;
    if (rescan)
      await index.scan({ url: this.info.rootUri, name: this.info.name }).catch(() => undefined);
    await index.whenReady([this.info.rootUri]);
    const { entries } = await queryIndexedFiles(index, this.info.rootUri, true);
    if (!entries.length && !rescan) return this.#listIndexedChildren(parentUri, true);
    return entries
      .filter((entry) => sameParentUri(entry.parentUrl || entry.parent, parentUri))
      .map((entry) => this.#fromIndex(entry));
  }

  async #walkIndexed(
    base: string,
    visitor: WalkVisitor,
    signal?: AbortSignal,
  ): Promise<WalkResult | undefined> {
    const index = nativeFileIndex();
    if (!index?.supports(this.info.rootUri)) return undefined;
    await index.whenReady([this.info.rootUri]);
    let files = await queryIndexedFiles(index, this.info.rootUri, false);
    if (!files.entries.length) {
      await index.scan({ url: this.info.rootUri, name: this.info.name }).catch(() => undefined);
      await index.whenReady([this.info.rootUri]);
      files = await queryIndexedFiles(index, this.info.rootUri, false);
    }
    let matched = 0;
    for (const item of files.entries) {
      throwIfAborted(signal);
      const entry = this.#fromIndex(item);
      if (!entry.isFile || !inScope(entry.path, base) || isIgnored(entry.path, base)) continue;
      matched += 1;
      if (await visitor.visit(entry)) return visitor.result(true, "index");
    }
    // Hidden and excluded folders are not indexed; let the filesystem walk them.
    if (!matched) return undefined;
    return visitor.result(!files.complete, "index");
  }

  #fromIndex(entry: Acode.FileIndexEntry): FileEntry {
    return {
      path: workspaceRelativeFromIndex(entry, this.sandbox, this.info.name),
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      size: entry.size,
    };
  }

  #serialize<T>(uri: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#fileLocks.get(uri) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.#fileLocks.set(
      uri,
      current.catch(() => undefined),
    );
    return current;
  }

  async #ensureDirectory(relativePath: string): Promise<void> {
    if (!relativePath) return;
    let current = "";
    for (const segment of this.sandbox.normalize(relativePath).split("/")) {
      const parentUri = this.sandbox.resolve(current).uri;
      current = [current, segment].filter(Boolean).join("/");
      const directory = acode.fsOperation(this.sandbox.resolve(current).uri);
      if (!(await directory.exists())) await acode.fsOperation(parentUri).createDirectory(segment);
    }
  }
}

function nativeFileIndex(): Acode.FileIndex | undefined {
  try {
    const index = acode.require("fileIndex");
    return index && typeof index.query === "function" ? index : undefined;
  } catch {
    return undefined;
  }
}

const INDEX_PAGE_SIZE = 1000;
const INDEX_MAX_PAGES = 50;

async function queryIndexedFiles(
  index: Acode.FileIndex,
  rootUri: string,
  includeDirectories: boolean,
): Promise<{ entries: Acode.FileIndexEntry[]; complete: boolean }> {
  const entries: Acode.FileIndexEntry[] = [];
  let cursor = 0;
  for (let page = 0; page < INDEX_MAX_PAGES; page += 1) {
    const result = await index.query({
      roots: [rootUri],
      includeDirectories,
      limit: INDEX_PAGE_SIZE,
      cursor,
    });
    entries.push(...(result.entries ?? []));
    if (!result.hasMore || result.cursor == null) return { entries, complete: true };
    cursor = result.cursor;
  }
  return { entries, complete: false };
}

function isMissingDirectoryReader(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /createReader is not a function/i.test(message);
}

const IGNORED_FOLDERS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache"]);

/** Skip noisy folders below `base`; a walk rooted inside one (e.g. `dist`) still sees its files. */
function isIgnored(path: string, base = ""): boolean {
  const relative = base && inScope(path, base) ? path.slice(base.length) : path;
  return relative.split("/").some((part) => IGNORED_FOLDERS.has(part));
}

/**
 * What Acode's native index leaves out, from its settings: hidden paths unless
 * "show hidden files" is on, and every `excludeFolders` glob.
 */
export function indexOmissions(): { hidden: boolean; excludeFolders: string[] } {
  try {
    const settings = acode.require("settings") as
      | { value?: { excludeFolders?: string[]; fileBrowser?: { showHiddenFiles?: boolean } } }
      | undefined;
    const value = settings?.value;
    return {
      hidden: value?.fileBrowser?.showHiddenFiles !== true,
      excludeFolders: Array.isArray(value?.excludeFolders) ? value.excludeFolders : [],
    };
  } catch {
    return { hidden: true, excludeFolders: [] };
  }
}

function inScope(path: string, base: string): boolean {
  return !base || path === base || path.startsWith(`${base}/`);
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

class WalkVisitor {
  #options: WalkOptions;
  #visited = 0;
  #skipped = 0;
  #scanned = 0;
  #stop: WalkResult["stop"];

  constructor(options: WalkOptions) {
    this.#options = options;
  }

  /** Returns true when the walk must stop. */
  async visit(entry: FileEntry): Promise<boolean> {
    const options = this.#options;
    if (this.#scanned >= (options.maxScanned ?? Number.POSITIVE_INFINITY)) {
      this.#stop = "scan-limit";
      return true;
    }
    this.#scanned += 1;
    if (options.filter && !options.filter(entry)) return false;
    if (this.#skipped < (options.skip ?? 0)) {
      this.#skipped += 1;
      return false;
    }
    if (this.#visited >= options.maxFiles) {
      this.#stop = "file-limit";
      return true;
    }
    this.#visited += 1;
    if (await options.onEntry(entry)) {
      this.#stop = "callback";
      return true;
    }
    return false;
  }

  result(
    stoppedEarly: boolean,
    source: WalkResult["source"],
    skippedFolders: string[] = [],
  ): WalkResult {
    const stop = stoppedEarly ? (this.#stop ?? "scan-limit") : undefined;
    return {
      visited: this.#visited,
      skipped: this.#skipped,
      scanned: this.#scanned,
      truncated: stop !== undefined,
      stop,
      source,
      skippedFolders,
    };
  }
}
