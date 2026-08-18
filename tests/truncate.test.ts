import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_LINES, selectReadOutput, truncateHead } from "../src/tools/truncate.ts";

test("returns short files unchanged", () => {
	assert.deepEqual(selectReadOutput("one\ntwo"), { text: "one\ntwo", truncated: false });
});

test("offset and limit select a line window and point at the rest", () => {
	const text = ["a", "b", "c", "d", "e"].join("\n");
	assert.equal(selectReadOutput(text, 2, 2).text, "[2 more lines in file. Use offset=4 to continue.]\n\nb\nc");
});

test("rejects an offset past the end of the file", () => {
	assert.throws(() => selectReadOutput("only", 4), /Offset 4 is beyond end of file \(1 lines total\)/);
});

test("caps an unbounded read at the default line limit", () => {
	const text = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, i) => `l${i + 1}`).join("\n");
	const output = selectReadOutput(text);
	assert.equal(output.truncated, true);
	assert.match(output.text, /Showing lines 1-2000 of 2005/);
	assert.match(output.text, /offset=2001/);
	assert.equal(truncateHead(text).outputLines, DEFAULT_MAX_LINES);
});
