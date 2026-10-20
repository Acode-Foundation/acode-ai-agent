import { afterEach, expect, test, vi } from "vitest";
import { loadDiffViewRuntime, setPluginBaseUrl } from "../src/platform/pluginAssets";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("loads the diff runtime through Acode's filesystem when fetch is unavailable", async () => {
  const runtime = { mount: vi.fn() };
  const script = {
    async: false,
    src: "",
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    remove: vi.fn(),
  };
  const readFile = vi.fn(async () => new TextEncoder().encode("diff runtime").buffer);
  const append = vi.fn(() => {
    (globalThis.window as Window & { acodeAiDiffViewRuntime?: typeof runtime }).acodeAiDiffViewRuntime =
      runtime;
    script.onload?.();
  });

  setPluginBaseUrl("file:///plugins/acode-ai-agent");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("file URL fetch unavailable")));
  vi.stubGlobal("acode", { fsOperation: vi.fn(() => ({ readFile })) });
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: vi.fn(() => script),
    head: { append },
  });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:diff-runtime"),
    revokeObjectURL: vi.fn(),
  });

  await expect(loadDiffViewRuntime()).resolves.toBe(runtime);

  expect(readFile).toHaveBeenCalledOnce();
  expect(script.src).toBe("blob:diff-runtime");
});