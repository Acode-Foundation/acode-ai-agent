import {
  err,
  ExecutionError,
  FileError,
  ok,
  type Context,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type Result,
  type ShellExecResult,
} from "@earendil-works/pi-agent-core";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { describeError, isAbortError } from "./errors";

type Validate = (path: string, content: string) => void;

/**
 * Pi's execution environment over an Acode workspace, so Pi's own file tools (edit) run
 * unchanged. Paths are `/`-rooted workspace-relative paths; reads and writes go through the
 * workspace, so open editor buffers are read and updated in place instead of the disk copy.
 */
export class WorkspaceExecutionEnv implements ExecutionEnv {
  readonly cwd = "/";
  #workspace: AcodeWorkspace;
  #validate: Validate;
  #writeTargets = new Map<string, "buffer" | "disk">();

  constructor(workspace: AcodeWorkspace, validate: Validate) {
    this.#workspace = workspace;
    this.#validate = validate;
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
    return this.#result(path, async () => {
      const relative = this.#relative(path);
      const text = await this.#workspace.readText(relative);
      this.#validate(relative, text);
      return text;
    });
  }

  readBinaryFile(path: string, _context: Context) {
    return this.#result(path, () => this.#workspace.readBinary(this.#relative(path)));
  }

  writeFile(path: string, content: string | Uint8Array, _context: Context) {
    return this.#result(path, async () => {
      if (typeof content !== "string")
        throw new FileError("not_supported", "Binary writes are not supported.", path);
      const relative = this.#relative(path);
      this.#validate(relative, content);
      this.#writeTargets.set(relative, await this.#workspace.writeText(relative, content));
    });
  }

  fileInfo(path: string, _context: Context) {
    return this.#result(path, async (): Promise<FileInfo> => {
      const relative = this.#relative(path);
      const name = relative.split("/").pop() ?? relative;
      try {
        const stat = await this.#workspace.stat(relative);
        return {
          name,
          path: `/${relative}`,
          kind: stat.isDirectory ? "directory" : "file",
          size: Number(stat.size) || 0,
          mtimeMs: Number(stat.modifiedDate) || 0,
        };
      } catch (error) {
        // An open editor buffer counts as a file even before it exists on disk.
        const text = await this.#workspace.readText(relative).catch(() => {
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

  openTextLineReader(path: string) {
    return unsupported<never>(path);
  }
  readTextLines(path: string) {
    return unsupported<string[]>(path);
  }
  appendFile(path: string) {
    return unsupported<void>(path);
  }
  renameFile(path: string) {
    return unsupported<void>(path);
  }
  listDir(path: string) {
    return unsupported<FileInfo[]>(path);
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
  async exec(): Promise<Result<ShellExecResult, ExecutionError>> {
    return err(
      new ExecutionError("shell_unavailable", "No shell in the workspace file environment."),
    );
  }
  async cleanup(): Promise<void> {}

  #relative(path: string): string {
    return this.#workspace.sandbox.normalize(path.replace(/^\/+/, ""));
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
  if (/escape|outside the workspace|invalid|absolute/i.test(message)) return "invalid";
  return "unknown";
}

async function unsupported<T>(path: string): Promise<Result<T, FileError>> {
  return err(
    new FileError("not_supported", "Not supported in the workspace file environment.", path),
  );
}
