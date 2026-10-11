import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";

/** What the host sends to start one script. */
export type WorkerInit = {
  type: "init";
  code: string;
  /** `jsName` is the identifier form of `name` (`toCodemodeIdentifier`). */
  tools: { name: string; jsName: string; description: string }[];
  globals: { name: string; spread: boolean }[];
  wasm: WebAssembly.Module;
  memoryLimitBytes?: number;
  /** Store values as JSON text, keyed by store key. */
  store: Record<string, string>;
  /**
   * Set to 1 by the host to stop a running VM. Only usable where `SharedArrayBuffer` exists;
   * otherwise `Worker.terminate()` alone stops the script.
   */
  interrupt?: SharedArrayBuffer;
};

/** The result of one tool or global call. `payload` is JSON on success, the error message otherwise. */
export type CallResult = { type: "result"; id: number; ok: boolean; payload?: string };

export type HostToWorkerMessage = WorkerInit | CallResult;

export type WorkerToHostMessage =
  | { type: "call"; id: number; target: "tool" | "global"; name: string; args?: string }
  | { type: "output"; item: CodemodeOutputItem }
  | { type: "done"; ok: true; value?: string; writes: string }
  | { type: "done"; ok: false; error: string }
  | { type: "crash"; message: string };

/** The side of a message channel one end sees: a Web Worker's global scope or a test double. */
export type MessagePortLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "call" || type === "output" || type === "done" || type === "crash";
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "init" || type === "result";
}
