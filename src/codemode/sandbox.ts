import type {
  CodemodeCall,
  CodemodeError,
  CodemodeOutputItem,
  CodemodeStoreWrites,
  CodemodeTool,
} from "@earendil-works/pi-codemode";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { isWorkerToHostMessage, type WorkerInit, type WorkerToHostMessage } from "./protocol";

/** The worker as the host sees it: a Web Worker, or an in-process double in tests. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  terminate(): void;
};

/** What a sandbox needs to start scripts: the compiled QuickJS module and a way to start a worker. */
export type CodemodeRuntime = {
  wasm: WebAssembly.Module;
  createWorker(): WorkerLike;
};

export type CodemodeResult =
  | {
      ok: true;
      value: unknown;
      output: CodemodeOutputItem[];
      calls: CodemodeCall[];
      storeWrites: CodemodeStoreWrites;
    }
  | { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[] };

export type CodemodeSandboxOptions = {
  tools?: CodemodeTool[];
  globals?: CodemodeTool[];
  /** Hard deadline for one script; `Infinity` runs until it settles or is aborted. */
  timeoutMs?: number;
  memoryLimitBytes?: number;
  runtime: () => Promise<CodemodeRuntime>;
};

export type ExecuteOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  store?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 300_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBALS = new Set([
  "tools",
  "ALL_TOOLS",
  "console",
  "text",
  "image",
  "exit",
  "globalThis",
  "store",
  "load",
]);

/**
 * Runs JavaScript in a QuickJS VM inside a Web Worker. The script sees `tools.<name>(args)`,
 * `ALL_TOOLS`, `text`, `image`, `exit`, `console.*`, `store`/`load`, and the configured globals;
 * nothing else (no timers, `fetch`, DOM, or modules). Each `execute()` gets its own worker and VM,
 * so a runaway script is killed with `terminate()` and cannot affect a later run.
 */
export class CodemodeSandbox {
  readonly #tools = new Map<string, CodemodeTool>();
  readonly #globals = new Map<string, CodemodeTool>();
  readonly #timeoutMs: number;
  readonly #memoryLimitBytes?: number;
  readonly #runtime: () => Promise<CodemodeRuntime>;
  readonly #running = new Set<Execution>();
  #closed = false;

  constructor(options: CodemodeSandboxOptions) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#memoryLimitBytes = options.memoryLimitBytes;
    this.#runtime = options.runtime;
    for (const tool of options.tools ?? []) {
      if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
      this.#tools.set(tool.name, tool);
    }
    const namespaces = new Set<string>();
    for (const global of options.globals ?? []) {
      const parts = global.name.split(".");
      if (
        parts.length > 2 ||
        !parts.every((part) => IDENTIFIER.test(part)) ||
        RESERVED_GLOBALS.has(parts[0]!)
      )
        throw new Error(`Invalid global name "${global.name}"`);
      if (this.#globals.has(global.name))
        throw new Error(`Global "${global.name}" is already registered`);
      if (parts.length === 2) namespaces.add(parts[0]!);
      this.#globals.set(global.name, global);
    }
    for (const name of namespaces)
      if (this.#globals.has(name))
        throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
  }

  /**
   * `code` is an async function body: `return` and top-level `await` work. Never rejects for
   * script failures; those come back as `{ ok: false }`.
   */
  execute(code: string, options: ExecuteOptions = {}): Promise<CodemodeResult> {
    if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
    const execution = new Execution({
      code,
      tools: new Map(this.#tools),
      globals: this.#globals,
      timeoutMs: options.timeoutMs ?? this.#timeoutMs,
      signal: options.signal,
      memoryLimitBytes: this.#memoryLimitBytes,
      store: serializeStore(options.store),
      runtime: this.#runtime(),
    });
    this.#running.add(execution);
    return execution.promise.finally(() => this.#running.delete(execution));
  }

  /** Aborts running scripts (they resolve with `kind: "aborted"`) and rejects new ones. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#running].map((execution) => execution.abort("Sandbox closed")));
  }
}

type ExecutionOptions = {
  code: string;
  tools: Map<string, CodemodeTool>;
  globals: Map<string, CodemodeTool>;
  timeoutMs: number;
  signal?: AbortSignal;
  memoryLimitBytes?: number;
  store: Record<string, string>;
  runtime: Promise<CodemodeRuntime>;
};

type Pending = { record?: CodemodeCall; startedAt: number; controller: AbortController };

/**
 * The prelude that serializes values for the host runs in the same VM as the script, so a script
 * that patches built-ins can make it send malformed data. Such payloads fail the run as a sandbox error.
 */
class BridgeError extends Error {}

class Execution {
  readonly promise: Promise<CodemodeResult>;
  #resolve!: (result: CodemodeResult) => void;
  #worker?: WorkerLike;
  readonly #interrupt =
    typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated
      ? new SharedArrayBuffer(4)
      : undefined;
  readonly #tools: Map<string, CodemodeTool>;
  readonly #globals: Map<string, CodemodeTool>;
  readonly #signal?: AbortSignal;
  readonly #timer?: ReturnType<typeof setTimeout>;
  readonly #output: CodemodeOutputItem[] = [];
  readonly #calls: CodemodeCall[] = [];
  readonly #pending = new Map<number, Pending>();
  #finished = false;

  constructor(options: ExecutionOptions) {
    this.promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
    this.#tools = options.tools;
    this.#globals = options.globals;
    this.#signal = options.signal;
    if (Number.isFinite(options.timeoutMs))
      this.#timer = setTimeout(
        () =>
          this.#finish({
            kind: "timeout",
            message: `Execution timed out after ${options.timeoutMs} ms`,
          }),
        options.timeoutMs,
      );
    if (options.signal?.aborted) this.#onAbort();
    else options.signal?.addEventListener("abort", this.#onAbort, { once: true });
    options.runtime.then(
      (runtime) => this.#start(options, runtime),
      (error: unknown) =>
        this.#finish({
          kind: "sandbox",
          message: `Failed to load the script runtime: ${errorMessage(error)}`,
        }),
    );
  }

  abort(message: string): Promise<CodemodeResult> {
    this.#finish({ kind: "aborted", message });
    return this.promise;
  }

  #start(options: ExecutionOptions, runtime: CodemodeRuntime): void {
    if (this.#finished) return;
    const init: WorkerInit = {
      type: "init",
      code: options.code,
      tools: [...options.tools.values()].map((tool) => ({
        name: tool.name,
        jsName: toCodemodeIdentifier(tool.name),
        description: tool.description ?? "",
      })),
      globals: [...options.globals.values()].map((global) => ({
        name: global.name,
        spread: global.spread === true,
      })),
      wasm: runtime.wasm,
      memoryLimitBytes: options.memoryLimitBytes,
      store: options.store,
      interrupt: this.#interrupt,
    };
    let worker: WorkerLike;
    try {
      worker = runtime.createWorker();
    } catch (error) {
      this.#finish({ kind: "sandbox", message: `Failed to start worker: ${errorMessage(error)}` });
      return;
    }
    this.#worker = worker;
    worker.addEventListener("message", ({ data }) => {
      // An exception here would leave the execution unsettled.
      try {
        this.#handleMessage(data);
      } catch (error) {
        this.#finish({
          kind: "sandbox",
          message:
            error instanceof BridgeError
              ? `Sandbox bridge broken: ${error.message}. The script may have modified built-ins such as a prototype's toJSON.`
              : `Sandbox host failed: ${errorMessage(error)}`,
        });
      }
    });
    worker.addEventListener("error", (event: { message?: string }) => {
      this.#finish({ kind: "sandbox", message: event.message || "The script worker failed" });
    });
    worker.postMessage(init);
  }

  readonly #onAbort = () => {
    const reason = this.#signal?.reason;
    this.#finish({
      kind: "aborted",
      message: reason instanceof Error ? reason.message : "Execution aborted",
    });
  };

  #handleMessage(message: unknown): void {
    if (this.#finished) return;
    if (!isWorkerToHostMessage(message)) throw new BridgeError("unknown message from the worker");
    switch (message.type) {
      case "output":
        this.#output.push(message.item);
        break;
      case "call":
        if (this.#pending.has(message.id)) throw new BridgeError(`duplicate call id ${message.id}`);
        void this.#handleCall(message);
        break;
      case "done":
        this.#handleDone(message);
        break;
      case "crash":
        this.#finish({ kind: "sandbox", message: message.message });
        break;
    }
  }

  #handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
    // Decode everything before #finish(), which must not throw once it starts.
    if (!message.ok) {
      this.#finish(parseScriptError(message.error));
      return;
    }
    const value =
      message.value === undefined ? undefined : parseBridgeJson(message.value, "return value");
    this.#finish(undefined, value, parseStoreWrites(message.writes));
  }

  async #handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
    const { id, name } = message;
    const isTool = message.target === "tool";
    const record: CodemodeCall | undefined = isTool
      ? { name, status: "cancelled", durationMs: 0 }
      : undefined;
    if (record) this.#calls.push(record);
    const pending: Pending = {
      record,
      startedAt: performance.now(),
      controller: new AbortController(),
    };
    this.#pending.set(id, pending);
    let status: CodemodeCall["status"];
    let reply: { type: "result"; id: number; ok: boolean; payload?: string };
    try {
      const tool = (isTool ? this.#tools : this.#globals).get(name);
      if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
      const args = message.args === undefined ? undefined : JSON.parse(message.args);
      const value = await tool.execute(args, { signal: pending.controller.signal });
      reply = {
        type: "result",
        id,
        ok: true,
        payload: value === undefined ? undefined : JSON.stringify(value),
      };
      status = "ok";
    } catch (error) {
      reply = { type: "result", id, ok: false, payload: errorMessage(error) };
      status = "error";
    }
    // Already cancelled by #finish(): the record keeps "cancelled" and the worker is gone.
    if (!this.#pending.delete(id)) return;
    if (record) {
      record.status = status;
      record.durationMs = performance.now() - pending.startedAt;
    }
    this.#worker?.postMessage(reply);
  }

  #finish(error?: CodemodeError, value?: unknown, writes?: CodemodeStoreWrites): void {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#timer);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    const now = performance.now();
    for (const pending of this.#pending.values()) {
      if (pending.record) pending.record.durationMs = now - pending.startedAt;
      pending.controller.abort();
    }
    this.#pending.clear();
    if (this.#interrupt) Atomics.store(new Int32Array(this.#interrupt), 0, 1);
    try {
      this.#worker?.terminate();
    } catch {
      // A worker that cannot be terminated is already gone.
    }
    this.#resolve(
      error
        ? { ok: false, error, output: this.#output, calls: this.#calls }
        : {
            ok: true,
            value,
            output: this.#output,
            calls: this.#calls,
            storeWrites: writes ?? { set: {}, delete: [] },
          },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeStore(store: Record<string, unknown> | undefined): Record<string, string> {
  const serialized: Record<string, string> = {};
  for (const [key, value] of Object.entries(store ?? {})) {
    const json = JSON.stringify(value);
    if (json !== undefined) serialized[key] = json;
  }
  return serialized;
}

function parseBridgeJson(json: string, what: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new BridgeError(`${what} is not valid JSON`);
  }
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
  const entries = parseBridgeJson(json, "store writes");
  if (!Array.isArray(entries)) throw new BridgeError("store writes are not an array");
  const writes: CodemodeStoreWrites = { set: {}, delete: [] };
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      (entry.length === 2 ? typeof entry[1] !== "string" : entry.length !== 1)
    )
      throw new BridgeError("store writes contain a malformed entry");
    const [key, value] = entry as [string, string?];
    if (value === undefined) writes.delete.push(key);
    else writes.set[key] = parseBridgeJson(value, `store value for ${JSON.stringify(key)}`);
  }
  return writes;
}

function parseScriptError(json: string): CodemodeError {
  const parsed = parseBridgeJson(json, "script error");
  if (typeof parsed !== "object" || parsed === null)
    throw new BridgeError("script error is not an object");
  const { name, message, stack } = parsed as Record<string, unknown>;
  if (
    typeof message !== "string" ||
    (name !== undefined && typeof name !== "string") ||
    (stack !== undefined && typeof stack !== "string")
  )
    throw new BridgeError("script error is malformed");
  return { kind: "script", name, message, stack };
}
