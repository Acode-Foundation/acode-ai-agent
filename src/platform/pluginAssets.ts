let pluginBaseUrl = "";
let diffRuntimePromise: Promise<AcodeDiffViewRuntime> | undefined;

export type DiffViewInput = {
  path: string;
  oldContents: string;
  newContents: string;
};

export type AcodeDiffViewRuntime = {
  mount(container: HTMLElement, input: DiffViewInput): () => void;
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
  const ready = window.acodeAiDiffViewRuntime;
  if (ready) return Promise.resolve(ready);
  if (diffRuntimePromise) return diffRuntimePromise;
  const pending = new Promise<AcodeDiffViewRuntime>((resolve, reject) => {
    if (!pluginBaseUrl) {
      reject(new Error("The diff viewer asset path is unavailable."));
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = `${pluginBaseUrl}/diff-view.js`;
    script.onload = () => {
      if (window.acodeAiDiffViewRuntime) resolve(window.acodeAiDiffViewRuntime);
      else reject(new Error("The diff viewer did not initialize."));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Could not load the diff viewer."));
    };
    document.head.append(script);
  });
  diffRuntimePromise = pending.catch((error) => {
    diffRuntimePromise = undefined;
    throw error;
  });
  return diffRuntimePromise;
}

declare global {
  interface Window {
    acodeAiDiffViewRuntime?: AcodeDiffViewRuntime;
  }
}
