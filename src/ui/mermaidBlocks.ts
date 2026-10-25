import { type AcodeMermaidRuntime, loadMermaidRuntime } from "../platform/pluginAssets";

const BLOCK_SELECTOR = '.md-code[data-lang="mermaid"]:not([data-pending])';

/**
 * Draw closed ```mermaid fences as diagrams, keeping the code block as the fallback.
 * Runs synchronously once the renderer has loaded, so re-rendered messages do not flicker.
 * Returns a cleanup that detaches every diagram it drew.
 */
export function mountMermaidBlocks(root: ParentNode): () => void {
  const blocks = [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
  if (!blocks.length) return () => {};
  const cleanups: Array<() => void> = [];
  let cancelled = false;
  const drawAll = (runtime: AcodeMermaidRuntime) => {
    for (const block of blocks) {
      if (block.isConnected) cleanups.push(drawBlock(runtime, block));
    }
  };
  const ready = window.acodeAiMermaidRuntime;
  if (ready) drawAll(ready);
  else {
    void loadMermaidRuntime().then(
      (runtime) => {
        if (!cancelled) drawAll(runtime);
      },
      (error) => console.warn("Could not load the diagram renderer", error),
    );
  }
  return () => {
    cancelled = true;
    for (const cleanup of cleanups) cleanup();
  };
}

function drawBlock(runtime: AcodeMermaidRuntime, block: HTMLElement): () => void {
  const source = block.querySelector("pre")?.textContent ?? "";
  if (!source.trim()) return () => {};
  const view = document.createElement("div");
  view.className = "md-mermaid";
  block.querySelector("pre")?.before(view);
  block.classList.add("has-diagram");
  const showSource = () => {
    block.classList.remove("has-diagram");
    view.remove();
  };
  // On a parse error, show the source instead of pele's inline error.
  const unmount = runtime.mount(view, source, showSource);
  return () => {
    unmount();
    showSource();
  };
}
