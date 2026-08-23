import { expect, test } from "vitest";
import { presentError } from "../src/ui/ErrorNotice.tsx";

test("keeps short errors compact", () => {
	expect(presentError("Permission denied")).toEqual({ summary: "Permission denied", details: undefined });
});

test("summarizes multiline errors and keeps the complete details", () => {
	const message = "Request failed\nTypeError: something went wrong\n    at plugin.js:10:3";
	expect(presentError(message)).toEqual({ summary: "Request failed", details: message });
});

test("clips an excessively long first line without allowing it to widen the UI", () => {
	const message = `Network failure: ${"x".repeat(300)}`;
	const result = presentError(message);
	expect(result.summary.length).toBe(220);
	expect(result.summary.endsWith("…")).toBe(true);
	expect(result.details).toBe(message);
});
