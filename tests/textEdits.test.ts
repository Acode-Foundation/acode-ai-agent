import { expect, test } from "vitest";
import { globMatcher } from "../src/tools/glob.ts";
import { applyExactEdit } from "../src/tools/textEdits.ts";

test("applies one unique exact edit", () => {
	expect(applyExactEdit("alpha beta", "beta", "gamma")).toEqual({
		text: "alpha gamma",
		replacements: 1,
	});
});

test("rejects missing, empty, and ambiguous matches", () => {
	expect(() => applyExactEdit("alpha", "", "x")).toThrow(/cannot be empty/);
	expect(() => applyExactEdit("alpha", "beta", "x")).toThrow(/No exact match/);
	expect(() => applyExactEdit("x x", "x", "y")).toThrow(/found 2/);
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

test("replace_all deliberately replaces every non-overlapping match", () => {
	expect(applyExactEdit("x x x", "x", "", true)).toEqual({
		text: "  ",
		replacements: 3,
	});
});
