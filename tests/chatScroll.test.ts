import { expect, test } from "vitest";
import { readThreadSnapshot, scrollTopAfterViewport } from "../src/ui/useChatScroll.ts";

test("a thread at the bottom stays pinned after the pane shrinks", () => {
	const before = readThreadSnapshot(2000, 1200, 800);
	expect(before.atEnd).toBe(true);
	expect(scrollTopAfterViewport(before, 2000, 400)).toBe(1600);
});

test("a scrolled-away thread keeps its offset when the pane shrinks", () => {
	const before = readThreadSnapshot(2000, 400, 800);
	expect(before.atEnd).toBe(false);
	expect(before.fromEnd).toBe(800);
	expect(scrollTopAfterViewport(before, 2000, 400)).toBe(400);
});

test("a small scroll away from the latest message is not treated as at-end", () => {
	const before = readThreadSnapshot(2000, 1120, 800);
	expect(before.fromEnd).toBe(80);
	expect(before.atEnd).toBe(false);
	expect(scrollTopAfterViewport(before, 2000, 400)).toBe(1120);
});
