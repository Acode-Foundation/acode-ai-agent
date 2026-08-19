import { expect, test } from "vitest";
import { mentionedFilePaths, splitUserText, userPartsFromMessage } from "../src/ui/composerDraft.ts";
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
});
