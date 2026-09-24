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

export type PathKind = "file" | "folder";

/** What a move, copy or delete touched, so tools can tell the agent about open editor tabs. */
export type PathChange = {
  kind: PathKind;
  /** Files copied, for a folder copy. */
  files?: number;
  /** Editor tabs under the path that were re-pointed (move) or detached (delete). */
  openFiles: number;
  /** Of those, tabs with unsaved buffer changes the disk copy does not have. */
  unsavedFiles: number;
};

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
   * Move or rename a file or folder to the full path `to`. Missing parent folders are created,
   * an existing destination is never overwritten, and open editor tabs follow the move.
   */
  async move(from: string, to: string, signal?: AbortSignal): Promise<PathChange> {
    const source = this.sandbox.resolve(from);
    const target = this.sandbox.resolve(to);
    if (!source.relativePath) throw new Error("Cannot move the workspace root.");
    if (!target.relativePath) throw new Error("A destination path is required.");
    if (source.relativePath === target.relativePath)
      throw new Error(`${source.relativePath} is already at that path.`);
    if (inScope(target.relativePath, source.relativePath))
      throw new Error(`Cannot move ${source.relativePath} into itself.`);
    return this.#serialize(source.uri, async () => {
      const kind = await this.#kind(source.relativePath, signal);
      // A case-only rename finds the source itself on case-insensitive storage.
      const caseOnly = source.relativePath.toLowerCase() === target.relativePath.toLowerCase();
      if (!caseOnly) await this.#assertMissing(target);
      const [fromParent, fromName] = splitPath(source.relativePath);
      const [toParent, toName] = splitPath(target.relativePath);
      throwIfAborted(signal);
      const created = await this.#ensureDirectory(toParent);

      if (fromParent === toParent) {
        await this.#rename(source.uri, fromName, toName);
      } else {
        // moveTo keeps the name, so step aside first when the new folder already has one.
        const clash =
          toName !== fromName &&
          (await exists(this.sandbox.resolve(joinPath(toParent, fromName)).uri));
        const staged = clash ? temporaryName(fromName) : fromName;
        const aside = await this.#rename(source.uri, fromName, staged);
        const moved = await acode.fsOperation(aside).moveTo(this.sandbox.resolve(toParent).uri);
        await this.#rename(moved, staged, toName);
      }
      if (!(await exists(target.uri)))
        throw new Error(
          `Acode reported ${source.relativePath} as moved, but ${target.relativePath} was not found afterwards. Check both paths with list_dir.`,
        );

      const open = this.#retargetOpenFiles(source.relativePath, target.relativePath);
      notifyRemoved(source.uri);
      notifyAdded(
        this.sandbox.resolve(created ?? target.relativePath).uri,
        created ? "folder" : kind,
      );
      return { kind, ...open };
    });
  }

  /**
   * Copy a file or folder to the full path `to`. Files open in the editor are copied from
   * their buffer, so unsaved agent edits come along. Never overwrites.
   */
  async copy(from: string, to: string, signal?: AbortSignal): Promise<PathChange> {
    const source = this.sandbox.resolve(from);
    const target = this.sandbox.resolve(to);
    if (!target.relativePath) throw new Error("A destination path is required.");
    if (source.relativePath === target.relativePath)
      throw new Error(`${target.relativePath} is the source path.`);
    if (inScope(target.relativePath, source.relativePath))
      throw new Error(`Cannot copy ${source.relativePath || "the workspace"} into itself.`);
    const kind = source.relativePath ? await this.#kind(source.relativePath, signal) : "folder";
    await this.#assertMissing(target);
    const created = await this.#ensureDirectory(splitPath(target.relativePath)[0]);
    let files = 0;
    const copyEntry = async (fromPath: string, toPath: string, isFolder: boolean) => {
      throwIfAborted(signal);
      const [parent, name] = splitPath(toPath);
      const parentUri = this.sandbox.resolve(parent).uri;
      if (!isFolder) {
        const content = await this.#snapshot(fromPath);
        const url = await acode.fsOperation(parentUri).createFile(name, "");
        await acode.fsOperation(url).writeFile(content);
        files += 1;
        return;
      }
      await acode.fsOperation(parentUri).createDirectory(name);
      for (const child of sortEntries(
        await this.#listViaFs(this.sandbox.resolve(fromPath), signal),
      ))
        await copyEntry(child.path, joinPath(toPath, child.name), child.isDirectory);
    };
    await copyEntry(source.relativePath, target.relativePath, kind === "folder");
    notifyAdded(
      this.sandbox.resolve(created ?? target.relativePath).uri,
      created ? "folder" : kind,
    );
    return { kind, files: kind === "folder" ? files : undefined, openFiles: 0, unsavedFiles: 0 };
  }

  /**
   * Delete a file or folder. A folder with entries needs `recursive`. Editor tabs for deleted
   * files stay open as unsaved buffers, as when deleting from Acode's file browser.
   */
  async remove(
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<PathChange & { entries?: number }> {
    const { relativePath, uri } = this.sandbox.resolve(path);
    if (!relativePath) throw new Error("Cannot delete the workspace root.");
    return this.#serialize(uri, async () => {
      const kind = await this.#kind(relativePath, options.signal);
      let entries: number | undefined;
      if (kind === "folder") {
        entries = (await this.#listViaFs({ relativePath, uri }, options.signal)).length;
        if (entries && !options.recursive)
          throw new Error(
            `${relativePath} is a folder with ${entries} entr${entries === 1 ? "y" : "ies"}. ` +
              "Pass recursive: true to delete it and everything inside.",
          );
      }
      throwIfAborted(options.signal);
      try {
        await acode.fsOperation(uri).delete();
      } catch (error) {
        // Some providers (Terminal SAF) only delete empty folders.
        if (kind !== "folder" || !(await exists(uri))) throw error;
        await this.#deleteTree({ relativePath, uri }, options.signal);
      }
      if (await exists(uri))
        throw new Error(`Acode reported ${relativePath} as deleted, but it still exists.`);
      const open = this.#retargetOpenFiles(relativePath, undefined);
      notifyRemoved(uri);
      return { kind, entries, ...open };
    });
  }

  /** Create a folder and any missing parents. Returns false when it already existed. */
  async createDirectory(path: string): Promise<boolean> {
    const { relativePath, uri } = this.sandbox.resolve(path);
    if (!relativePath) return false;
    if (await exists(uri)) {
      if ((await this.#kind(relativePath)) === "file")
        throw new Error(`${relativePath} already exists as a file.`);
      return false;
    }
    const created = await this.#ensureDirectory(relativePath);
    if (created) notifyAdded(this.sandbox.resolve(created).uri, "folder");
    return true;
  }

  async #kind(path: string, signal?: AbortSignal): Promise<PathKind> {
    const stat = await this.stat(path, signal);
    return stat?.isFile === true || stat?.isDirectory === false ? "file" : "folder";
  }

  async #assertMissing(target: { relativePath: string; uri: string }): Promise<void> {
    if (await exists(target.uri))
      throw new Error(
        `${target.relativePath} already exists. Delete it first or choose another destination.`,
      );
  }

  /** Rename in place; a case-only rename goes through a temporary name. */
  async #rename(url: string, from: string, to: string): Promise<string> {
    if (from === to) return url;
    if (from.toLowerCase() === to.toLowerCase())
      url = await acode.fsOperation(url).renameTo(temporaryName(from));
    return acode.fsOperation(url).renameTo(to);
  }

  /** Current contents for a copy: the editor buffer when the file is open, else disk bytes. */
  async #snapshot(path: string): Promise<string | ArrayBuffer> {
    const { uri } = this.sandbox.resolve(path);
    const openFile = editorManager.getFile(uri, "uri");
    if (openFile?.loaded) return openFile.session.getValue();
    return acode.fsOperation(uri).readFile();
  }

  async #deleteTree(
    folder: { relativePath: string; uri: string },
    signal?: AbortSignal,
  ): Promise<void> {
    for (const child of await this.#listViaFs(folder, signal)) {
      throwIfAborted(signal);
      const resolved = this.sandbox.resolve(child.path);
      if (child.isDirectory) await this.#deleteTree(resolved, signal);
      else await acode.fsOperation(resolved.uri).delete();
    }
    await acode.fsOperation(folder.uri).delete();
  }

  /**
   * Point editor tabs at or under `from` to their new path, or detach them (`to` undefined).
   * Acode's `openFolder.renameItem` rewrites file tabs to `<new>/<filename>`, so do it here.
   */
  #retargetOpenFiles(
    from: string,
    to: string | undefined,
  ): { openFiles: number; unsavedFiles: number } {
    let openFiles = 0;
    let unsavedFiles = 0;
    try {
      for (const file of editorManager.files ?? []) {
        const relative = this.sandbox.relative(file?.uri);
        if (relative === undefined || !inScope(relative, from)) continue;
        openFiles += 1;
        if (file.isUnsaved) unsavedFiles += 1;
        if (to === undefined) {
          (file as { uri: string | null }).uri = null;
          continue;
        }
        file.uri = this.sandbox.resolve(to + relative.slice(from.length)).uri;
        if (relative === from) file.filename = splitPath(to)[1];
      }
      if (openFiles && to === undefined) {
        editorManager.onupdate?.("delete-file");
        editorManager.emit?.("update", "delete-file");
      }
    } catch {
      // Editor manager is optional in tests and non-Acode hosts.
    }
    return { openFiles, unsavedFiles };
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

  /** Create `relativePath` and missing parents; returns the topmost folder it created. */
  async #ensureDirectory(relativePath: string): Promise<string | undefined> {
    if (!relativePath) return undefined;
    let current = "";
    let created: string | undefined;
    for (const segment of this.sandbox.normalize(relativePath).split("/")) {
      const parentUri = this.sandbox.resolve(current).uri;
      current = [current, segment].filter(Boolean).join("/");
      const directory = acode.fsOperation(this.sandbox.resolve(current).uri);
      if (await directory.exists()) continue;
      await acode.fsOperation(parentUri).createDirectory(segment);
      created ??= current;
    }
    return created;
  }
}

async function exists(uri: string): Promise<boolean> {
  try {
    return await acode.fsOperation(uri).exists();
  } catch {
    return false;
  }
}

function splitPath(path: string): [parent: string, name: string] {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? [path.slice(0, slash), path.slice(slash + 1)] : ["", path];
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function temporaryName(name: string): string {
  return `.${name}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
}

/** Keep Acode's file tree and native index in step with a tool's change. Best effort. */
function notifyAdded(uri: string, kind: PathKind): void {
  try {
    const result: unknown = openFolderApi()?.add(uri, kind);
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // The sidebar refreshes on its own the next time the folder is opened.
  }
}

function notifyRemoved(uri: string): void {
  try {
    openFolderApi()?.removeItem(uri);
  } catch {
    // Same as above.
  }
}

function openFolderApi(): Acode.OpenFolder | undefined {
  try {
    const api = acode.require("openfolder") as Acode.OpenFolder | undefined;
    return typeof api?.add === "function" ? api : undefined;
  } catch {
    return undefined;
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
