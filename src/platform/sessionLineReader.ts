import {
  FileError,
  err,
  ok,
  type Context,
  type FileSystem,
  type Result,
} from "@earendil-works/pi-agent-core";

type TextLineReader = Extract<
  Awaited<ReturnType<FileSystem["openTextLineReader"]>>,
  { ok: true }
>["value"];
type TextLine = Exclude<
  Extract<Awaited<ReturnType<TextLineReader["readLine"]>>, { ok: true }>["value"],
  undefined
>;

const CHUNK_BYTES = 64 * 1024;

/** A byte source keeps the line decoder independent of the host filesystem. */
export type SessionByteSource = {
  size: number;
  read(start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer>;
};

function sessionFileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error;
  const code = (error as { code?: number })?.code;
  return new FileError(
    code === 1 ? "not_found" : code === 2 || code === 6 ? "permission_denied" : "unknown",
    error instanceof Error ? error.message : String(error),
    path,
  );
}

/** Memory is bounded by one chunk plus the current line (which can itself be large). */
export class SessionLineReader implements TextLineReader {
  #decoder = new TextDecoder();
  #offset = 0;
  #buffer = "";
  #ended = false;
  #closed = false;
  #pending?: AbortController;

  constructor(
    private source: SessionByteSource | undefined,
    private path: string,
  ) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    if (context.abortSignal?.aborted)
      return err(new FileError("aborted", "Read aborted", this.path));
    if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.path));
    if (this.#pending) return err(new FileError("invalid", "Read already in progress", this.path));
    const pending = new AbortController();
    this.#pending = pending;
    const abort = () => pending.abort();
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (pending.signal.aborted) throw new FileError("aborted", "Read aborted", this.path);
        const newline = this.#buffer.indexOf("\n");
        if (newline !== -1) {
          const text = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          return ok({ text, terminated: true });
        }
        if (this.#ended) {
          if (!this.#buffer) return ok(undefined);
          const text = this.#buffer;
          this.#buffer = "";
          return ok({ text, terminated: false });
        }
        const source = this.source!;
        if (this.#offset >= source.size) {
          this.#buffer += this.#decoder.decode();
          this.#ended = true;
          continue;
        }
        const end = Math.min(this.#offset + CHUNK_BYTES, source.size);
        const bytes = await source.read(this.#offset, end, pending.signal);
        if (pending.signal.aborted) throw new FileError("aborted", "Read aborted", this.path);
        if (!bytes.byteLength || bytes.byteLength > end - this.#offset)
          throw new FileError("unknown", "Invalid session chunk length", this.path);
        // Do not advance the cursor or decoder after cancellation; a retry reads the same bytes.
        this.#offset += bytes.byteLength;
        this.#buffer += this.#decoder.decode(bytes, { stream: true });
      }
    } catch (error) {
      return err(sessionFileError(error, this.path));
    } finally {
      context.abortSignal?.removeEventListener("abort", abort);
      this.#pending = undefined;
    }
  }

  async close(_context: Context): Promise<void> {
    this.#closed = true;
    this.#pending?.abort();
    this.#buffer = "";
    this.source = undefined;
    this.#decoder = new TextDecoder();
  }
}

/** Use Cordova's FileReader, not Blob.arrayBuffer(): Cordova File slices are native file references. */
export async function openCordovaSessionReader(
  uri: string,
  path: string,
  context: Context,
): Promise<TextLineReader> {
  const file = await new Promise<File>((resolve, reject) => {
    const signal = context.abortSignal;
    const abort = () => finish(new FileError("aborted", "Read aborted", path));
    const finish = (error?: unknown, file?: File) => {
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(file!);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const host = globalThis as unknown as {
      resolveLocalFileSystemURL?: (
        uri: string,
        success: (entry: {
          file(success: (file: File) => void, failure: (error: unknown) => void): void;
        }) => void,
        failure: (error: unknown) => void,
      ) => void;
    };
    try {
      if (!host.resolveLocalFileSystemURL) throw new Error("Cordova file reader is unavailable");
      host.resolveLocalFileSystemURL(
        uri,
        (entry) => {
          if (signal?.aborted) return;
          try {
            entry.file(
              (file) => finish(undefined, file),
              (error) => finish(error),
            );
          } catch (error) {
            finish(error);
          }
        },
        (error) => finish(error),
      );
    } catch (error) {
      finish(error);
    }
  });
  return new SessionLineReader(
    {
      size: file.size,
      read: (start, end, signal) =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          const finish = (error?: unknown) => {
            signal.removeEventListener("abort", abort);
            reader.onload = reader.onerror = reader.onabort = null;
            if (error !== undefined) reject(error);
            else if (reader.result instanceof ArrayBuffer) resolve(reader.result);
            else reject(new Error("Cordova returned a non-binary session chunk"));
          };
          const abort = () => {
            finish(new FileError("aborted", "Read aborted", path));
            try {
              reader.abort();
            } catch {
              // Native cleanup is best-effort; the pending read is already rejected.
            }
          };
          reader.onload = () => finish();
          reader.onerror = () => finish(reader.error ?? new Error("Session read failed"));
          reader.onabort = () => finish(new FileError("aborted", "Read aborted", path));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          try {
            reader.readAsArrayBuffer(file.slice(start, end));
          } catch (error) {
            finish(error);
          }
        }),
    },
    path,
  );
}
