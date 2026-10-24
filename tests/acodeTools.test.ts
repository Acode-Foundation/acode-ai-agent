import { afterEach, expect, test, vi } from "vitest";
import { acodeActionPreview, createAcodeTools, normalizeChanges } from "../src/tools/acodeTools";
import { runTool } from "./toolHarness";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAcode(
  values: Record<string, unknown>,
  commands: Acode.RegisteredCommand[] = [],
  extra: Record<string, unknown> = {},
) {
  const update = vi.fn(async (changes: Record<string, unknown>) => {
    Object.assign(values, changes);
  });
  const execute = vi.fn(() => true);
  const modules: Record<string, unknown> = {
    settings: { value: values, update },
    commands: { registry: { list: () => commands, execute } },
    ...extra,
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

test("acode_update_settings accepts the argument shapes models guess", () => {
  const expected = [{ key: "maxFileSize", value: "50" }];
  expect(normalizeChanges({ settings: '[{"key": "maxFileSize", "value": 50}]' })).toEqual(expected);
  expect(normalizeChanges({ changes: [{ key: "maxFileSize", value: 50 }] })).toEqual(expected);
  expect(normalizeChanges({ key: "maxFileSize", value: 50 })).toEqual(expected);
  expect(normalizeChanges({ values: { maxFileSize: 50, textWrap: true } })).toEqual([
    ...expected,
    { key: "textWrap", value: "true" },
  ]);
  expect(normalizeChanges({ changes: [{ key: "fontSize", value: "14px" }] })).toEqual([
    { key: "fontSize", value: "14px" },
  ]);
});

test("app themes are offered by id, and a paid theme without Pro is refused", async () => {
  const themes = {
    list: () => [
      { id: "dark", name: "Dark", version: "free" },
      { id: "ocean", name: "Ocean", version: "paid" },
    ],
    apply: vi.fn(),
  };
  stubAcode({ appTheme: "dark" }, [], { themes, config: { HAS_PRO: false } });

  expect(text(await runTool(tool("acode_settings"), { keys: ["appTheme"] }))).toContain(
    "one of: dark, ocean",
  );
  await expect(
    runTool(tool("acode_update_settings"), { changes: [{ key: "appTheme", value: "ocean" }] }),
  ).rejects.toThrow("ocean is a paid theme");
  expect(themes.apply).not.toHaveBeenCalled();
});

test("listing every setting shows each value, grouped by page, without cutting any off", async () => {
  const values: Record<string, unknown> = { maxFileSize: 12, tabSize: 2, customTheme: {} };
  for (let index = 0; index < 100; index++) values[`plugin${index}`] = index;
  stubAcode(values);

  const output = text(await runTool(tool("acode_settings"), {}));

  expect(output).toContain("Settings → Editor settings:\n  tabSize = 2");
  expect(output).toContain(
    "settings.json only (Settings → Edit settings.json):\n  maxFileSize = 12",
  );
  expect(output).toContain("  plugin99 = 99");
  expect(output).not.toContain("more; narrow");
  expect(output).not.toContain("customTheme");
});

test("a result loads the tool for the obvious next step, in user chats only", async () => {
  stubAcode({ tabSize: 2 });
  const chat = (userChat: boolean) => ({
    api: {
      commit: async () => userChat,
      agent: async () => ({ tools: [{ name: "acode_settings" }] }),
    },
  });

  const loaded = await runTool(tool("acode_settings"), { query: "tab" }, chat(true));
  expect(loaded.control).toEqual({ addTools: ["acode_update_settings"] });
  expect(loaded.details).toMatchObject({ loaded: ["acode_update_settings"] });
  expect(text(loaded)).toContain("Loaded for your next turn: acode_update_settings.");

  const subagent = await runTool(tool("acode_settings"), { query: "tab" }, chat(false));
  expect(subagent.control).toBeUndefined();
});
