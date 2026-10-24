import { afterEach, expect, test, vi } from "vitest";
import { acodeActionPreview, createAcodeTools } from "../src/tools/acodeTools";
import { runTool } from "./toolHarness";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAcode(values: Record<string, unknown>, commands: Acode.RegisteredCommand[] = []) {
  const update = vi.fn(async (changes: Record<string, unknown>) => {
    Object.assign(values, changes);
  });
  const execute = vi.fn(() => true);
  const modules: Record<string, unknown> = {
    settings: { value: values, update },
    commands: { registry: { list: () => commands, execute } },
  };
  vi.stubGlobal("acode", { require: (name: string) => modules[name] });
  return { update, execute };
}

function tool(name: string) {
  return createAcodeTools().find((candidate) => candidate.name === name)!;
}

function text(output: { content: Array<{ text?: string }> }): string {
  return output.content.map((part) => part.text ?? "").join("");
}

test("acode_settings finds a setting by words with its value, label and place in the UI", async () => {
  stubAcode({ fontSize: "12px", tabSize: 2, customTheme: {} });

  const output = await runTool(tool("acode_settings"), { query: "font size" });

  expect(text(output)).toBe(
    'fontSize = "12px" · Font size (Settings → Editor settings) · Editor text size as CSS, e.g. 14px.',
  );
});

test("acode_settings leaves out internal settings", async () => {
  stubAcode({ tabSize: 2, customTheme: { a: 1 }, quicktoolsItems: [1] });

  const output = await runTool(tool("acode_settings"), {});

  expect(text(output)).toContain("tabSize = 2");
  expect(text(output)).not.toContain("customTheme");
  expect(text(output)).not.toContain("quicktoolsItems");
});

test("acode_update_settings coerces values to the setting's type and merges objects", async () => {
  const values = { tabSize: 2, textWrap: false, search: { caseSensitive: false, regExp: false } };
  const { update } = stubAcode(values);

  const output = await runTool(tool("acode_update_settings"), {
    changes: [
      { key: "tabSize", value: "4" },
      { key: "textWrap", value: "true" },
      { key: "search", value: '{"regExp":true}' },
    ],
  });

  expect(update).toHaveBeenCalledWith(
    { tabSize: 4, textWrap: true, search: { caseSensitive: false, regExp: true } },
    false,
    true,
  );
  expect(text(output)).toContain("tabSize: 2 → 4");
});

test("acode_update_settings rejects unknown keys, wrong types and values outside the options", async () => {
  const { update } = stubAcode({ tabSize: 2, openFileListPos: "header" });
  const run = (key: string, value: string) =>
    runTool(tool("acode_update_settings"), { changes: [{ key, value }] });

  await expect(run("nope", "1")).rejects.toThrow("nope is not an Acode setting");
  await expect(run("tabSize", "wide")).rejects.toThrow("tabSize takes a number");
  await expect(run("openFileListPos", "left")).rejects.toThrow(
    "openFileListPos must be one of: header, sidebar, bottom",
  );
  expect(update).not.toHaveBeenCalled();
});

test("acode_commands filters by words, matching split camelCase names", async () => {
  stubAcode({}, [
    { name: "openTerminal", description: "Open terminal", key: "Ctrl-`" },
    { name: "splitPaneRight", description: "Split pane right", key: null },
  ]);

  const output = await runTool(tool("acode_commands"), { query: "split pane" });

  expect(text(output)).toBe("splitPaneRight — Split pane right");
});

test("acode_run_command runs a known command and refuses unknown ones", async () => {
  const { execute } = stubAcode({}, [{ name: "openTerminal", description: "Open terminal" }]);

  expect(text(await runTool(tool("acode_run_command"), { name: "openterminal" }))).toBe(
    "Ran openTerminal.",
  );
  expect(execute).toHaveBeenCalledWith("openTerminal", undefined, undefined);
  await expect(runTool(tool("acode_run_command"), { name: "launchRockets" })).rejects.toThrow(
    "No Acode command named launchRockets",
  );
});

test("the approval preview shows each setting's current and new value", () => {
  stubAcode({ tabSize: 2 });

  expect(
    acodeActionPreview("acode_update_settings", { changes: [{ key: "tabSize", value: "4" }] }),
  ).toBe("Tab size (tabSize): 2 → 4");
});
