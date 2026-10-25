// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { mountMermaidBlocks } from "../src/ui/mermaidBlocks.ts";
import "../src/ui/mermaidViewRuntime.ts";

afterEach(() => {
  document.body.replaceChildren();
});

/** Mirrors the fence markup from markdownRender (happy-dom's DOMPurify drops `<figure>`). */
function renderInto(source: string, lang = "mermaid", pending = false): HTMLElement {
  const host = document.createElement("div");
  const block = document.createElement("figure");
  block.className = "md-code is-wrap";
  block.dataset.lang = lang;
  if (pending) block.setAttribute("data-pending", "");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.append(code);
  block.append(document.createElement("figcaption"), pre);
  host.append(block);
  document.body.append(host);
  return host;
}

test("draws a closed mermaid fence as a diagram and hides its source", () => {
  const host = renderInto("flowchart LR\n  A[Start] --> B[Done]");
  const unmount = mountMermaidBlocks(host);
  const block = host.querySelector<HTMLElement>(".md-code")!;
  expect(block.classList.contains("has-diagram")).toBe(true);
  expect(block.querySelector(".md-mermaid svg.pele")).not.toBeNull();
  expect(block.querySelector("pre")?.textContent).toContain("A[Start] --> B[Done]");

  unmount();
  expect(block.classList.contains("has-diagram")).toBe(false);
  expect(block.querySelector(".md-mermaid")).toBeNull();
});

test("keeps the code block when the diagram cannot be parsed", () => {
  const host = renderInto("flowchart LR\n  A -->");
  mountMermaidBlocks(host);
  const block = host.querySelector<HTMLElement>(".md-code")!;
  expect(block.classList.contains("has-diagram")).toBe(false);
  expect(block.querySelector(".md-mermaid")).toBeNull();
});

test("waits for a streaming mermaid fence to close", () => {
  const host = renderInto("flowchart LR\n  A --> B", "mermaid", true);
  mountMermaidBlocks(host);
  expect(host.querySelector(".md-mermaid")).toBeNull();
});

test("leaves other fences alone", () => {
  const host = renderInto("const x = 1;", "ts");
  mountMermaidBlocks(host);
  expect(host.querySelector(".md-mermaid")).toBeNull();
});
