import { expect, test } from "vitest";
import {
	draftFileFromPaste,
	draftFromParts,
	expandPasteMarkers,
	isLargePaste,
	mentionedFilePaths,
	normalizePastedText,
	pasteMarker,
	promptTextFromDraft,
	splitUserText,
	userPartsFromMessage,
} from "../src/ui/composerDraft.ts";
import { fileDir, fileExt, mentionQueryAt, rankMentionFiles } from "../src/workspace/fileMentions.ts";
import { mimeFromName, modelAcceptsImages, normalizeImageMime, toPiImages } from "../src/platform/promptImages.ts";

test("detects an @ mention query at the caret", () => {
	expect(mentionQueryAt("look at @ap", 12)).toEqual({ start: 8, query: "ap" });
	expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
	expect(mentionQueryAt("@src/", 5)).toEqual({ start: 0, query: "src/" });
	expect(mentionQueryAt("email me", 8)).toBeUndefined();
	expect(mentionQueryAt("see src/app.ts", 14)).toBeUndefined();
});

test("does not treat emails as mentions", () => {
	expect(mentionQueryAt("write user@op", 13)).toBeUndefined();
});

test("splits sent text into file chips and copy", () => {
	const parts = splitUserText("Please review @src/ui/App.tsx and @README.md together.");
	expect(parts).toEqual([
		{ type: "text", text: "Please review " },
		{ type: "file", path: "src/ui/App.tsx" },
		{ type: "text", text: " and " },
		{ type: "file", path: "README.md" },
		{ type: "text", text: " together." },
	]);
	expect(mentionedFilePaths("see @src/a.ts")).toEqual(["src/a.ts"]);
});

test("ignores email addresses when splitting user text", () => {
	expect(splitUserText("ping user@host.com about it")).toEqual([
		{ type: "text", text: "ping user@host.com about it" },
	]);
});

test("rebuilds user parts from a Pi user message with images", () => {
	const parts = userPartsFromMessage([
		{ type: "text", text: "What is in @shots/home.png [#image shot.png] today" },
		{ type: "image", data: "abc", mimeType: "image/png" },
	]);
	expect(parts).toEqual([
		{ type: "text", text: "What is in " },
		{ type: "file", path: "shots/home.png" },
		{ type: "text", text: " " },
		{ type: "image", data: "abc", mimeType: "image/png", name: "shot.png" },
		{ type: "text", text: " today" },
	]);
});

test("packages picked files for the model while keeping a compact file chip", () => {
	const prompt = promptTextFromDraft({
		text: "Review [#file outside.ts]",
		images: [],
		files: [{ id: "one", name: 'outside\".ts', content: "const end = `]]>`;", encoding: "text" }],
	});
	expect(prompt).toContain('"name":"outside\\\".ts"');
	expect(splitUserText(prompt)).toEqual([
		{ type: "text", text: "Review " },
		{ type: "attachment", name: "outside.ts" },
	]);
	const restored = draftFromParts(prompt);
	expect(restored.text).toBe("Review [#file outside.ts]");
	expect(restored.files).toMatchObject([{ name: 'outside".ts', content: "const end = `]]>`;", encoding: "text" }]);
});

test("uses Pi's large-paste thresholds", () => {
	expect(isLargePaste("short")).toBe(false);
	expect(isLargePaste("a\nb\nc\nd\ne\nf\ng\nh\ni\nj")).toBe(false);
	expect(isLargePaste("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk")).toBe(true);
	expect(isLargePaste("x".repeat(1000))).toBe(false);
	expect(isLargePaste("x".repeat(1001))).toBe(true);
});

test("normalizes pasted text the way Pi's editor does", () => {
	expect(normalizePastedText("a\r\nb\tc\r\x01d")).toBe("a\nb    c\nd");
});

test("builds Pi paste markers and expands them for the model", () => {
	const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
	expect(pasteMarker(1, lines)).toBe("[paste #1 +12 lines]");
	expect(pasteMarker(2, "x".repeat(1001))).toBe("[paste #2 1001 chars]");
	expect(expandPasteMarkers("see [paste #1 +12 lines] please", [
		{ id: "paste-1", name: "paste #1 +12 lines", content: lines, encoding: "text", kind: "paste", pasteId: 1 },
	])).toBe(`see ${lines} please`);
});

test("keeps large pastes as chips and stores the original text", () => {
	const content = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
	const file = draftFileFromPaste(content, []);
	expect(file).toMatchObject({ kind: "paste", pasteId: 1, name: "paste #1 +12 lines" });
	const prompt = promptTextFromDraft({
		text: `look at this ${pasteMarker(1, content)}`,
		images: [],
		files: [file],
	});
	expect(splitUserText(prompt)).toEqual([
		{ type: "text", text: "look at this " },
		{ type: "paste", id: 1, label: "[paste #1 +12 lines]" },
	]);
	const restored = draftFromParts(prompt);
	expect(restored.files).toMatchObject([{ kind: "paste", pasteId: 1, content }]);
	expect(userPartsFromMessage(prompt)).toMatchObject([
		{ type: "text", text: "look at this " },
		{ type: "attachment", name: "paste #1 +12 lines", content, encoding: "text", kind: "paste" },
	]);
});

test("ranks open files and basename prefix matches first", () => {
	const ranked = rankMentionFiles([
		{ path: "src/lib/button.ts", name: "button.ts" },
		{ path: "src/ui/App.tsx", name: "App.tsx", open: true },
		{ path: "src/ui/Apple.ts", name: "Apple.ts" },
		{ path: "README.md", name: "README.md" },
	], "ap", 10);
	expect(ranked.map((file) => file.path)).toEqual(["src/ui/App.tsx", "src/ui/Apple.ts"]);
	expect(fileDir("src/ui/App.tsx")).toBe("src/ui");
	expect(fileExt("src/ui/App.tsx")).toBe("tsx");
});

test("builds Pi image blocks without a data-url prefix", () => {
	expect(toPiImages([{ type: "image", data: "data:image/png;base64,abcd", mimeType: "image/png" }])).toEqual([
		{ type: "image", data: "abcd", mimeType: "image/png" },
	]);
	expect(normalizeImageMime("image/jpg")).toBe("image/jpeg");
	expect(mimeFromName("photo.WEBP")).toBe("image/webp");
	expect(modelAcceptsImages({ input: ["text", "image"] } as never)).toBe(true);
	expect(modelAcceptsImages({ input: ["text"] } as never)).toBe(false);
	expect(modelAcceptsImages({ input: ["text"], inputModalitiesKnown: false } as never)).toBeUndefined();
});
