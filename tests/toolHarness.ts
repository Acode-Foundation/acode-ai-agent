import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type {
  ToolDiagnostic,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MessagePortLike } from "../src/codemode/protocol";
import type { CodemodeRuntime, WorkerLike } from "../src/codemode/sandbox";
import { runCodemodeWorker } from "../src/codemode/workerMain";

export type ToolOutput = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError?: boolean;
  diagnostics: ToolDiagnostic[];
};

/**
 * Run a Pi durable tool outside a Harness: prepared and executed like the tool task does,
 * with omitted content taken from streamed output, and diagnostics collected.
 */
export async function runTool(
  tool: ToolRegistration,
  args: unknown,
  options: { signal?: AbortSignal; env?: ExecutionEnv; api?: Partial<ToolExecutionApi> } = {},
): Promise<ToolOutput> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  const output: string[] = [];
  const diagnostics: ToolDiagnostic[] = [];
  let details: unknown;
  const api = {
    taskId: 1,
    conversationId: 1,
    callId: "call",
    env: options.env,
    outputWindow: undefined,
    now: () => Date.now(),
    retainedOutput: () => ({ text: output.join(""), truncated: false }),
    output: (chunk: string | Uint8Array) =>
      output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    diagnostic: (item: ToolDiagnostic) => diagnostics.push(item),
    details: async (value: unknown) => {
      details = value;
    },
    ...options.api,
  } as unknown as ToolExecutionApi;
  const context = options.signal
    ? withAbortSignal(options.signal, BACKGROUND_CONTEXT)
    : BACKGROUND_CONTEXT;
  const result = await tool.execute(prepared as never, api, context);
  return {
    content: (result.output as ToolOutput["content"] | undefined) ?? [
      { type: "text", text: output.join("") },
    ],
    details: result.details ?? details,
    isError: result.isError,
    diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
  };
}

/** The old `execute(id, args, signal)` shape over `runTool`, for compact test call sites. */
export function legacyTool(tool: ToolRegistration, env?: ExecutionEnv) {
  return {
    ...tool,
    execute: (_id: string, args: unknown, signal?: AbortSignal) =>
      runTool(tool, args, { signal, env }),
  };
}

const wasm = WebAssembly.compile(readFileSync("node_modules/quickjs-wasi/quickjs.wasm"));

type Listener = (event: { data: unknown }) => void;

/** The real worker code on an in-process channel. Messages are async, like postMessage. */
export function inProcessRuntime(): () => Promise<CodemodeRuntime> {
  return async () => ({
    wasm: await wasm,
    createWorker: (): WorkerLike => {
      const toWorker = new Set<Listener>();
      const toHost = new Set<Listener>();
      let terminated = false;
      const deliver = (listeners: Set<Listener>, data: unknown) =>
        queueMicrotask(() => {
          if (!terminated) for (const listener of listeners) listener({ data });
        });
      const workerSide: MessagePortLike = {
        postMessage: (message) => deliver(toHost, message),
        addEventListener: (_type, listener) => toWorker.add(listener),
      };
      runCodemodeWorker(workerSide);
      return {
        postMessage: (message) => deliver(toWorker, message),
        addEventListener: (type: string, listener: Listener) => {
          if (type === "message") toHost.add(listener);
        },
        terminate: () => {
          terminated = true;
        },
      } as WorkerLike;
    },
  });
}
