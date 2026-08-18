import assert from "node:assert/strict";
import test from "node:test";
import { globMatcher } from "../src/tools/glob.ts";
import { applyExactEdit } from "../src/tools/textEdits.ts";

test("applies one unique exact edit", () => {
	assert.deepEqual(applyExactEdit("alpha beta", "beta", "gamma"), {
		text: "alpha gamma",
		replacements: 1,
	});
});

test("rejects missing, empty, and ambiguous matches", () => {
	assert.throws(() => applyExactEdit("alpha", "", "x"), /cannot be empty/);
	assert.throws(() => applyExactEdit("alpha", "beta", "x"), /No exact match/);
	assert.throws(() => applyExactEdit("x x", "x", "y"), /found 2/);
});

test("glob patterns match nested files even without **/", () => {
	const ts = globMatcher("*.ts");
	assert.equal(ts.test("src/ui/App.tsx"), false);
	assert.equal(ts.test("src/main.ts"), true);
	assert.equal(ts.test("main.ts"), true);
	assert.equal(globMatcher("src/**").test("src/ui/App.tsx"), true);
	assert.equal(globMatcher("**/*.css").test("src/ui/styles.css"), true);
});

test("glob braces match any listed extension", () => {
	const matcher = globMatcher("**/*.{md,json,js,xml}");
	assert.equal(matcher.test("readme.md"), true);
	assert.equal(matcher.test("plugin.json"), true);
	assert.equal(matcher.test("src/main.js"), true);
	assert.equal(matcher.test("AndroidManifest.xml"), true);
	assert.equal(matcher.test("src/main.ts"), false);
});

test("replace_all deliberately replaces every non-overlapping match", () => {
	assert.deepEqual(applyExactEdit("x x x", "x", "", true), {
		text: "  ",
		replacements: 3,
	});
});

