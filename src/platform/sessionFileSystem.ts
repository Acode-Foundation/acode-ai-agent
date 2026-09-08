import {
  FileError,
  ok,
  err,
  type Context,
  type FileInfo,
  type FileSystem,
  type Result,
} from "@earendil-works/pi-agent-core";

/** A private virtual path namespace; workspace tools never receive this adapter. */
export class SessionFileSystem implements FileSystem {
  readonly cwd = "/";
  readonly rootUri: string;
  constructor(
    rootUri: string,
    private readonly fs: Acode.FS = acode.fsOperation,
    private readonly append = appendWithCordova,
  ) {
    if (!rootUri.startsWith("file:///"))
      throw new Error("Session storage requires a private local file directory.");
    this.rootUri = rootUri.replace(/\/+$/, "");
  }
  #path(path: string): string {
    if (path.includes("\0") || path.includes("\\") || /^[a-z][a-z\d+.-]*:/i.test(path))
      throw new FileError("invalid", "Invalid session path", path);
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length)
          throw new FileError("permission_denied", "Path escapes session storage", path);
        parts.pop();
      } else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }
  #uri(path: string): string {
    return this.rootUri + this.#path(path).split("/").map(encodeURIComponent).join("/");
  }
  async #result<T>(path: string, fn: () => Promise<T> | T): Promise<Result<T, FileError>> {
    try {
      return ok(await fn());
    } catch (error) {
      if (error instanceof FileError) return err(error);
      const code = (error as { code?: number })?.code;
      return err(
        new FileError(
          code === 1 ? "not_found" : code === 2 || code === 6 ? "permission_denied" : "unknown",
          error instanceof Error ? error.message : String(error),
          path,
        ),
      );
    }
  }
  absolutePath(path: string, _context: Context) {
    return this.#result(path, () => this.#path(path));
  }
  joinPath(parts: string[], _context: Context) {
    return this.#result(parts.join("/"), () => this.#path(parts.join("/")));
  }
  readTextFile(path: string, _context: Context) {
    return this.#result(path, () => this.fs(this.#uri(path)).readFile("utf-8"));
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, _context: Context) {
    return this.#result(path, async () =>
      (await this.fs(this.#uri(path)).readFile("utf-8")).split(/\r?\n/).slice(0, options?.maxLines),
    );
  }
  readBinaryFile(path: string, _context: Context) {
    return this.#result(
      path,
      async () => new Uint8Array(await this.fs(this.#uri(path)).readFile()),
    );
  }
  async #mkdir(path: string, recursive = true): Promise<void> {
    const normalized = this.#path(path);
    // The application data directory exists; create our dedicated root first.
    if (!(await this.fs(this.rootUri).exists())) {
      const slash = this.rootUri.lastIndexOf("/");
      await this.fs(this.rootUri.slice(0, slash)).createDirectory(
        decodeURIComponent(this.rootUri.slice(slash + 1)),
      );
    }
    if (normalized === "/") return;
    const slash = normalized.lastIndexOf("/");
    const parent = normalized.slice(0, slash) || "/";
    if (recursive) await this.#mkdir(parent);
    if (!(await this.fs(this.#uri(normalized)).exists()))
      await this.fs(this.#uri(parent)).createDirectory(normalized.slice(slash + 1));
  }
  async #ensureFile(path: string): Promise<Acode.FileSystem> {
    const normalized = this.#path(path);
    const slash = normalized.lastIndexOf("/");
    await this.#mkdir(normalized.slice(0, slash) || "/");
    const file = this.fs(this.#uri(normalized));
    if (!(await file.exists()))
      await this.fs(this.#uri(normalized.slice(0, slash) || "/")).createFile(
        normalized.slice(slash + 1),
        "",
      );
    return file;
  }
  writeFile(path: string, content: string | Uint8Array, _context: Context) {
    return this.#result(path, async () => {
      const file = await this.#ensureFile(path);
      await file.writeFile(typeof content === "string" ? content : Uint8Array.from(content).buffer);
    });
  }
  appendFile(path: string, content: string | Uint8Array, _context: Context) {
    return this.#result(path, async () => {
      await this.#ensureFile(path);
      await this.append(this.#uri(path), content);
    });
  }
  renameFile(source: string, destination: string, _context: Context) {
    return this.#result(source, async () => {
      const from = this.#path(source),
        to = this.#path(destination);
      if (from === to) return;
      if (from.slice(0, from.lastIndexOf("/")) !== to.slice(0, to.lastIndexOf("/")))
        throw new FileError("not_supported", "Session publication requires sibling files", source);
      // Cordova uses native rename first. Its copy fallback on failure is an
      // accepted host limitation; never delete the destination beforehand.
      await this.fs(this.#uri(from)).renameTo(to.slice(to.lastIndexOf("/") + 1));
    });
  }
  async #info(path: string): Promise<FileInfo> {
    const addressed = this.#path(path);
    const stat = await this.fs(this.#uri(addressed)).stat();
    return {
      path: addressed,
      name: addressed.split("/").at(-1) || "",
      kind: stat.isDirectory ? "directory" : "file",
      size: stat.size,
      mtimeMs: sessionTimestamp(stat.modifiedDate) ?? 0,
    };
  }
  fileInfo(path: string, _context: Context) {
    return this.#result(path, () => this.#info(path));
  }
  listDir(path: string, _context: Context) {
    return this.#result(path, async () =>
      Promise.all(
        (await this.fs(this.#uri(path)).lsDir()).map((entry) =>
          this.#info(`${this.#path(path)}/${entry.name}`),
        ),
      ),
    );
  }
  canonicalPath(path: string, _context: Context) {
    return this.#result(path, async () => {
      await this.#info(path);
      return this.#path(path);
    });
  }
  exists(path: string, _context: Context) {
    return this.#result(path, () => this.fs(this.#uri(path)).exists());
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, _context: Context) {
    return this.#result(path, () => this.#mkdir(path, options?.recursive ?? true));
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    _context: Context,
  ) {
    return this.#result(path, async () => {
      if (this.#path(path) === "/")
        throw new FileError("permission_denied", "Cannot remove session storage root", path);
      const target = this.fs(this.#uri(path));
      if (options?.force && !(await target.exists())) return;
      if ((await target.stat()).isDirectory && !options?.recursive && (await target.lsDir()).length)
        throw new FileError("invalid", "Directory is not empty", path);
      await target.delete();
    });
  }
  createTempDir(prefix: string | undefined, _context: Context) {
    return this.#result("/", async () => {
      const path = `/${safeName(prefix ?? "tmp-")}${crypto.randomUUID()}`;
      await this.#mkdir(path);
      return path;
    });
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, _context: Context) {
    return this.#result("/", async () => {
      const path = `/${safeName(options?.prefix ?? "")}${crypto.randomUUID()}${safeName(options?.suffix ?? "")}`;
      await this.#ensureFile(path);
      return path;
    });
  }
  async cleanup(_context: Context): Promise<void> {}
}
function safeName(value: string): string {
  if (/[\/\\\0]/.test(value)) throw new FileError("invalid", "Invalid temporary file name");
  return value;
}

type Writer = {
  length: number;
  seek(offset: number): void;
  write(data: ArrayBuffer): void;
  onwriteend: (() => void) | null;
  onerror: ((event: { target: { error: unknown } }) => void) | null;
};
type LocalEntry = {
  createWriter(success: (writer: Writer) => void, failure: (error: unknown) => void): void;
};
/** Append bytes without rewriting previous JSONL transactions. Pi serializes commits. */
function appendWithCordova(uri: string, content: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const host = globalThis as unknown as {
      resolveLocalFileSystemURL?: (
        uri: string,
        success: (entry: LocalEntry) => void,
        failure: (error: unknown) => void,
      ) => void;
    };
    if (!host.resolveLocalFileSystemURL) {
      reject(new Error("Cordova file writer is unavailable"));
      return;
    }
    host.resolveLocalFileSystemURL(
      uri,
      (entry) =>
        entry.createWriter((writer) => {
          writer.onerror = (event) => reject(event.target.error);
          writer.onwriteend = () => resolve();
          try {
            writer.seek(writer.length);
            writer.write(
              Uint8Array.from(
                typeof content === "string" ? new TextEncoder().encode(content) : content,
              ).buffer,
            );
          } catch (error) {
            reject(error);
          }
        }, reject),
      reject,
    );
  });
}

export function privateSessionFileSystem(): SessionFileSystem {
  const directory = (globalThis as unknown as { cordova?: { file?: { dataDirectory?: string } } })
    .cordova?.file?.dataDirectory;
  if (!directory)
    throw new Error("Acode internal data storage is unavailable. Chats cannot be persisted.");
  return new SessionFileSystem(`${directory.replace(/\/+$/, "")}/ai-agent`);
}

/** Host file dates may be milliseconds, numeric strings, or serialized dates. */
export function sessionTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const timestamp =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : typeof value === "string"
          ? Number.isFinite(Number(value))
            ? Number(value)
            : Date.parse(value)
          : NaN;
  return Number.isFinite(timestamp) &&
    timestamp > 0 &&
    Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : undefined;
}
