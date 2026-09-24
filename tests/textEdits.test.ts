import { expect, test } from "vitest";
import { globMatcher } from "../src/tools/glob.ts";
import { editPairs, legacyEditArguments } from "../src/tools/textEdits.ts";

test("reads edit pairs from Pi, single, and legacy edit_file arguments", () => {
  expect(editPairs({ edits: [{ oldText: "a", newText: "b" }] })).toEqual([
    { oldText: "a", newText: "b" },
  ]);
  expect(editPairs({ edits: '[{"oldText":"a","newText":"b"}]' })).toEqual([
    { oldText: "a", newText: "b" },
  ]);
  expect(editPairs({ old_string: "x", new_string: "y" })).toEqual([{ oldText: "x", newText: "y" }]);
  expect(editPairs({ path: "a.ts" })).toEqual([]);
});

test("maps old_string/new_string onto Pi's edits shape", () => {
  expect(
    legacyEditArguments({ path: "a.ts", old_string: "x", new_string: "y", replace_all: true }),
  ).toEqual({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
  const untouched = { path: "a.ts", edits: [] };
  expect(legacyEditArguments(untouched)).toBe(untouched);
});

test("glob patterns match nested files even without **/", () => {
  const ts = globMatcher("*.ts");
  expect(ts.test("src/ui/App.tsx")).toBe(false);
  expect(ts.test("src/main.ts")).toBe(true);
  expect(ts.test("main.ts")).toBe(true);
  expect(globMatcher("src/**").test("src/ui/App.tsx")).toBe(true);
  expect(globMatcher("**/*.css").test("src/ui/styles.css")).toBe(true);
});

test("glob braces match any listed extension", () => {
  const matcher = globMatcher("**/*.{md,json,js,xml}");
  expect(matcher.test("readme.md")).toBe(true);
  expect(matcher.test("plugin.json")).toBe(true);
  expect(matcher.test("src/main.js")).toBe(true);
  expect(matcher.test("AndroidManifest.xml")).toBe(true);
  expect(matcher.test("src/main.ts")).toBe(false);
});
