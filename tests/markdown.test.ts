import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../src/ui/markdownRender.ts";

test("renders headings, lists, fences, quotes, and emphasis through marked", () => {
	const html = renderMarkdown([
		"# Title",
		"",
		"A **bold** line and `code`.",
		"",
		"- one",
		"- two",
		"",
		"> note",
		"",
		"```ts",
		"const x = 1;",
		"```",
		"",
		"[docs](https://example.com)",
	].join("\n"));

	assert.match(html, /<h1>Title<\/h1>/);
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /<code>code<\/code>/);
	assert.match(html, /<ul>/);
	assert.match(html, /<blockquote>/);
	assert.match(html, /data-lang="ts"/);
	assert.match(html, /const x = 1;/);
	assert.match(html, /href="https:\/\/example.com"/);
});

test("renders GFM tables", () => {
	const html = renderMarkdown("| File | Status |\n| --- | --- |\n| a.ts | done |");
	assert.match(html, /<table>/);
	assert.match(html, /<th>File<\/th>/);
	assert.match(html, /<td>a.ts<\/td>/);
});

test("does not turn javascript urls into links", () => {
	const html = renderMarkdown("[x](javascript:alert(1))");
	assert.doesNotMatch(html, /javascript:/);
});
