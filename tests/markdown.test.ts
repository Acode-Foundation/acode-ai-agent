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
	assert.match(html, /class="md-code"/);
	assert.match(html, /data-copy/);
	assert.match(html, /data-wrap/);
	assert.match(html, /md-code-icon-copy/);
	assert.match(html, /const x = 1;/);
	assert.match(html, /class="md-ref md-ref--web"/);
	assert.match(html, /data-kind="web"/);
	assert.match(html, /md-ref-icon/);
	assert.match(html, /href="https:\/\/example.com"/);
});

test("renders GFM task lists", () => {
	const html = renderMarkdown("- [x] done\n- [ ] todo");
	assert.match(html, /type="checkbox"/);
	assert.match(html, /checked/);
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

test("renders github alerts and file references", () => {
	const html = renderMarkdown([
		"> [!NOTE]",
		"> Keep the sandbox.",
		"",
		"See [main.ts](src/main.ts).",
		"",
		"```ts title=\"app.ts\"",
		"export const n = 2;",
		"```",
	].join("\n"));

	assert.match(html, /class="md-alert md-alert--note"/);
	assert.match(html, /md-alert-title/);
	assert.match(html, /class="md-ref md-ref--file"/);
	assert.match(html, /data-kind="file"/);
	assert.match(html, /md-ref-icon/);
	assert.match(html, /data-path="src\/main.ts"/);
	assert.match(html, /<a class="md-ref md-ref--file"/);
	assert.match(html, />app\.ts</);
});

test("leaves inline code as code", () => {
	const html = renderMarkdown("See `src/ui/App.tsx` and `const`.");
	assert.match(html, /<code>src\/ui\/App.tsx<\/code>/);
	assert.match(html, /<code>const<\/code>/);
	assert.doesNotMatch(html, /data-path="src\/ui\/App.tsx"/);
});

test("escapes fenced code", () => {
	const html = renderMarkdown("```html\n<div class=\"x\">&</div>\n```");
	assert.match(html, /&lt;div class=&quot;x&quot;&gt;&amp;&lt;\/div&gt;/);
	assert.doesNotMatch(html, /<div class="x">/);
});
