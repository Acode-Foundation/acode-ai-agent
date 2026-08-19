import { expect, test } from "vitest";
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

	expect(html).toMatch(/<h1>Title<\/h1>/);
	expect(html).toMatch(/<strong>bold<\/strong>/);
	expect(html).toMatch(/<code>code<\/code>/);
	expect(html).toMatch(/<ul>/);
	expect(html).toMatch(/<blockquote>/);
	expect(html).toMatch(/data-lang="ts"/);
	expect(html).toMatch(/class="md-code is-wrap"/);
	expect(html).toMatch(/data-copy/);
	expect(html).toMatch(/data-wrap/);
	expect(html).toMatch(/aria-pressed="true"/);
	expect(html).toMatch(/aria-label="Unwrap code"/);
	expect(html).toMatch(/md-code-icon-copy/);
	expect(html).toMatch(/const x = 1;/);
	expect(html).toMatch(/class="md-ref md-ref--web"/);
	expect(html).toMatch(/data-kind="web"/);
	expect(html).toMatch(/md-ref-icon/);
	expect(html).toMatch(/href="https:\/\/example.com"/);
});

test("renders GFM task lists", () => {
	const html = renderMarkdown("- [x] done\n- [ ] todo");
	expect(html).toMatch(/type="checkbox"/);
	expect(html).toMatch(/checked/);
});

test("renders GFM tables", () => {
	const html = renderMarkdown("| File | Status |\n| --- | --- |\n| a.ts | done |");
	expect(html).toMatch(/<table>/);
	expect(html).toMatch(/<th>File<\/th>/);
	expect(html).toMatch(/<td>a.ts<\/td>/);
});

test("does not turn javascript urls into links", () => {
	const html = renderMarkdown("[x](javascript:alert(1))");
	expect(html).not.toMatch(/javascript:/);
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

	expect(html).toMatch(/class="md-alert md-alert--note"/);
	expect(html).toMatch(/md-alert-title/);
	expect(html).toMatch(/class="md-ref md-ref--file"/);
	expect(html).toMatch(/data-kind="file"/);
	expect(html).toMatch(/md-ref-icon/);
	expect(html).toMatch(/data-path="src\/main.ts"/);
	expect(html).toMatch(/<a class="md-ref md-ref--file"/);
	expect(html).toMatch(/>app\.ts</);
});

test("leaves inline code as code", () => {
	const html = renderMarkdown("See `src/ui/App.tsx` and `const`.");
	expect(html).toMatch(/<code>src\/ui\/App.tsx<\/code>/);
	expect(html).toMatch(/<code>const<\/code>/);
	expect(html).not.toMatch(/data-path="src\/ui\/App.tsx"/);
});

test("escapes fenced code", () => {
	const html = renderMarkdown("```html\n<div class=\"x\">&</div>\n```");
	expect(html).toMatch(/&lt;div class=&quot;x&quot;&gt;&amp;&lt;\/div&gt;/);
	expect(html).not.toMatch(/<div class="x">/);
});
