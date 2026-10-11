import { readPluginAsset } from "../platform/pluginAssets";
import type { CodemodeRuntime, WorkerLike } from "./sandbox";

/** Files the build writes next to `main.js`. */
export const CODEMODE_WORKER_ASSET = "codemode-worker.js";
export const QUICKJS_WASM_ASSET = "quickjs.wasm";

let runtime: Promise<CodemodeRuntime> | undefined;

/**
 * The worker script and the QuickJS module, loaded on the first script run and kept for the
 * session. The worker starts from a Blob URL, which works whatever scheme the plugin folder uses.
 * A failed load is retried on the next run.
 */
export function loadCodemodeRuntime(): Promise<CodemodeRuntime> {
  runtime ??= (async () => {
    const [script, bytes] = await Promise.all([
      readPluginAsset(CODEMODE_WORKER_ASSET),
      readPluginAsset(QUICKJS_WASM_ASSET),
    ]);
    const wasm = await WebAssembly.compile(bytes);
    const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    return {
      wasm,
      createWorker: () => new Worker(url, { name: "acode-ai-codemode" }) as WorkerLike,
    };
  })().catch((error: unknown) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}
