let pluginBaseUrl = "";
const runtimePromises = new Map<string, Promise<unknown>>();

export type DiffViewInput = {
  path: string;
  oldContents: string;
  newContents: string;
};

export type AcodeDiffViewRuntime = {
  mount(container: HTMLElement, input: DiffViewInput): () => void;
};

export type AcodeMermaidRuntime = {
  /** Draws `source` into `container`; calls `onError` instead of throwing when it cannot. */
  mount(container: HTMLElement, source: string, onError: (error: unknown) => void): () => void;
};

export function setPluginBaseUrl(baseUrl: string): void {
  pluginBaseUrl = baseUrl.replace(/\/$/, "");
}

/** Read a file shipped next to `main.js`. */
export async function readPluginAsset(name: string): Promise<ArrayBuffer> {
  if (!pluginBaseUrl) throw new Error(`The plugin asset path is unavailable for ${name}.`);
  const url = `${pluginBaseUrl}/${name}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.arrayBuffer();
  } catch (error) {
    // Some WebView builds refuse fetch() on file URLs; Acode's file API reads them.
    const fs = typeof acode === "undefined" ? undefined : acode.fsOperation;
    if (!fs) throw error;
    return (await fs(url).readFile()) as ArrayBuffer;
  }
}

export function loadDiffViewRuntime(): Promise<AcodeDiffViewRuntime> {
  return loadRuntimeScript("diff-view.js", "diff viewer", () => window.acodeAiDiffViewRuntime);
}

export function loadMermaidRuntime(): Promise<AcodeMermaidRuntime> {
  return loadRuntimeScript(
    "mermaid-view.js",
    "diagram renderer",
    () => window.acodeAiMermaidRuntime,
  );
}

/** Load a script shipped next to `main.js` once and resolve the global it defines. */
function loadRuntimeScript<T>(file: string, label: string, read: () => T | undefined): Promise<T> {
  const ready = read();
  if (ready) return Promise.resolve(ready);
  const existing = runtimePromises.get(file) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = new Promise<T>((resolve, reject) => {
    if (!pluginBaseUrl) {
      reject(new Error(`The ${label} asset path is unavailable.`));
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = `${pluginBaseUrl}/${file}`;
    script.onload = () => {
      const runtime = read();
      if (runtime) resolve(runtime);
      else reject(new Error(`The ${label} did not initialize.`));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`Could not load the ${label}.`));
    };
    document.head.append(script);
  });
  const settled = pending.catch((error) => {
    runtimePromises.delete(file);
    throw error;
  });
  runtimePromises.set(file, settled);
  return settled;
}

declare global {
  interface Window {
    acodeAiDiffViewRuntime?: AcodeDiffViewRuntime;
    acodeAiMermaidRuntime?: AcodeMermaidRuntime;
  }
}
