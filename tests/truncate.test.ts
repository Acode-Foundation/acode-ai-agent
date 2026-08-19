import { expect, test } from "vitest";
import { DEFAULT_MAX_LINES, selectReadOutput, truncateHead } from "../src/tools/truncate.ts";

test("returns short files unchanged", () => {
	expect(selectReadOutput("one\ntwo")).toEqual({ text: "one\ntwo", truncated: false });
});

test("offset and limit select a line window and point at the rest", () => {
	const text = ["a", "b", "c", "d", "e"].join("\n");
	expect(selectReadOutput(text, 2, 2).text).toBe("[2 more lines in file. Use offset=4 to continue.]\n\nb\nc");
});

test("rejects an offset past the end of the file", () => {
	expect(() => selectReadOutput("only", 4)).toThrow(/Offset 4 is beyond end of file \(1 lines total\)/);
});

test("caps an unbounded read at the default line limit", () => {
	const text = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, i) => `l${i + 1}`).join("\n");
	const output = selectReadOutput(text);
	expect(output.truncated).toBe(true);
	expect(output.text).toMatch(/Showing lines 1-2000 of 2005/);
	expect(output.text).toMatch(/offset=2001/);
	expect(truncateHead(text).outputLines).toBe(DEFAULT_MAX_LINES);
});
