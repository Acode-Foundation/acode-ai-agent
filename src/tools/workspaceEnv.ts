import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  FileError,
  LineScanner,
  ok,
  type BinaryReader,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type Result,
  type Shell,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { isImagePath } from "../workspace/fileMentions";
import { describeError, isAbortError } from "./errors";
import { createTerminalShell } from "./terminalShell";
import { assertTextFile } from "./textFiles";

/**
 * Pi's execution environment over an Acode workspace, so Pi's own `read`, `write`,
 * `edit`, and `bash` tools run unchanged. Paths are `/`-rooted workspace-relative paths.
 * Text reads and writes go through the workspace, so a file open in the editor is read
 * from and written to its buffer instead of the disk copy. `bash` runs in Acode
 * Terminal when the workspace lives on its filesystem.
 */
export class WorkspaceExecutionEnv implements ExecutionEnv {
  readonly id: string;
  readonly cwd = "/";
  readonly workspace: AcodeWorkspace;
  readonly shell: Shell | undefined;
  #writeTargets = new Map<string, "buffer" | "disk">();

  /** `shell`: detected from the workspace when omitted; `null` for none. */
  constructor(workspace: AcodeWorkspace, shell?: Shell | null) {
    this.workspace = workspace;
    this.id = `acode:${workspace.info?.rootUri ?? ""}`;
    this.shell =
      shell === null ? undefined : (shell ?? createTerminalShell(workspace.info.rootUri));
  }

  /** Where the last write to `path` landed (open editor buffer or disk), consumed once. */
  takeWriteTarget(path: string): "buffer" | "disk" | undefined {
    const key = this.#relative(path);
    const target = this.#writeTargets.get(key);
    this.#writeTargets.delete(key);
    return target;
  }

  absolutePath(path: string, _context: Context) {
    return this.#result(path, () => `/${this.#relative(path)}`);
  }

  joinPath(parts: string[], _context: Context) {
    return this.#result(parts.join("/"), () => `/${this.#relative(parts.join("/"))}`);
  }

  canonicalPath(path: string, _context: Context) {
    return this.#result(path, () => `/${this.#relative(path)}`);
  }

  readTextFile(path: string, _context: Context) {
    return this.#result(path, () => this.#readText(this.#relative(path)));
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, _context: Context) {
    return this.#result(path, async () =>
      (await this.#readText(this.#relative(path))).split(/\r?\n/).slice(0, options?.maxLines),
    );
  }

  readBinaryFile(path: string, _context: Context) {
    return this.#result(path, () => this.workspace.readBinary(this.#relative(path)));
  }

  /** Whole-file reader: Acode file systems have no positional reads. Text comes from open buffers. */
  openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, _context: Context) {
    return this.#result(path, async (): Promise<BinaryReader> => {
      const relative = this.#relative(path);
      const bytes = isImagePath(relative)
        ? await this.workspace.readBinary(relative)
        : new TextEncoder().encode(await this.#readText(relative));
      const info: FileInfo = {
        name: relative.split("/").pop() ?? relative,
        path: `/${relative}`,
        kind: "file",
        size: bytes.length,
        mtimeMs: 0,
      };
      return {
        info: async () => ok(info),
        read: async (offset, length) => ok(bytes.subarray(offset, offset + Math.max(0, length))),
        scanLines: async ({ startLine, endLine }) => {
          const scanner = new LineScanner(startLine, endLine);
          scanner.push(bytes);
          return ok(scanner.finish());
        },
        close: async () => undefined,
      };
    });
  }

  writeFile(path: string, content: string | Uint8Array, _context: Context) {
    return this.#result(path, async () => {
      if (typeof content !== "string")
        throw new FileError("not_supported", "Binary writes are not supported.", path);
      const relative = this.#relative(path);
      if (!relative) throw new FileError("invalid", "A file path is required.", path);
      assertTextFile(relative, content);
      this.#writeTargets.set(relative, await this.workspace.writeText(relative, content));
    });
  }

  fileInfo(path: string, _context: Context) {
    return this.#result(path, async (): Promise<FileInfo> => {
      const relative = this.#relative(path);
      const name = relative.split("/").pop() ?? relative;
      try {
        const stat = await this.workspace.stat(relative);
        return {
          name,
          path: `/${relative}`,
          kind: stat.isDirectory ? "directory" : "file",
          size: Number(stat.size) || 0,
          mtimeMs: Number(stat.modifiedDate) || 0,
        };
      } catch (error) {
        // An open editor buffer counts as a file even before it exists on disk.
        const text = await this.workspace.readText(relative).catch(() => {
          throw error;
        });
        return { name, path: `/${relative}`, kind: "file", size: text.length, mtimeMs: 0 };
      }
    });
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : err(info.error);
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return ok(undefined);
  }

  openTextLineReader(path: string) {
    return unsupported<never>(path);
  }
  appendFile(path: string) {
    return unsupported<void>(path);
  }
  truncateFile(path: string) {
    return unsupported<void>(path);
  }
  renameFile(path: string) {
    return unsupported<void>(path);
  }
  listDir(path: string) {
    return unsupported<FileInfo[]>(path);
  }
  openDirReader(path: string) {
    return unsupported<never>(path);
  }
  watch() {
    return unsupported<never>("");
  }
  createDir(path: string) {
    return unsupported<void>(path);
  }
  remove(path: string) {
    return unsupported<void>(path);
  }
  createTempDir() {
    return unsupported<string>("");
  }
  createTempFile() {
    return unsupported<string>("");
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (!this.shell)
      return err(
        new ExecutionError(
          "shell_unavailable",
          "No terminal for this workspace. Only folders inside Acode Terminal can run commands.",
        ),
      );
    return this.shell.exec(command, options, context);
  }

  async cleanup(context: Context): Promise<void> {
    await this.shell?.cleanup(context);
  }

  async #readText(relative: string): Promise<string> {
    const text = await this.workspace.readText(relative);
    assertTextFile(relative, text);
    return text;
  }

  #relative(path: string): string {
    return this.workspace.sandbox.normalize(path.replace(/^\/+/, ""));
  }

  async #result<T>(path: string, fn: () => Promise<T> | T): Promise<Result<T, FileError>> {
    try {
      return ok(await fn());
    } catch (error) {
      if (error instanceof FileError) return err(error);
      return err(new FileError(fileErrorCode(error), describeError(error), path));
    }
  }
}

function fileErrorCode(error: unknown): FileErrorCode {
  if (isAbortError(error)) return "aborted";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 1) return "not_found";
  if (code === 2 || code === 6) return "permission_denied";
  const message = describeError(error);
  if (/not found|no such file|does not exist/i.test(message)) return "not_found";
  if (/escape|outside the workspace|invalid|absolute|binary|size limit/i.test(message))
    return "invalid";
  return "unknown";
}

async function unsupported<T>(path: string): Promise<Result<T, FileError>> {
  return err(
    new FileError("not_supported", "Not supported in the workspace file environment.", path),
  );
}
