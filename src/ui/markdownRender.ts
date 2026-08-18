import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";

const cache = new Map<string, string>();
const CACHE_MAX = 200;

marked.use({
	gfm: true,
	breaks: true,
	renderer: {
		code({ text, lang }: Tokens.Code): string {
			if (!text.trim()) return "";
			const safeLang = lang ? lang.replace(/[^\w.+#-]/g, "").slice(0, 32) : "";
			const langAttr = safeLang ? ` data-lang="${safeLang}"` : "";
			return `<pre${langAttr}><code>${escapeHtml(text)}</code></pre>\n`;
		},
		link({ href, text, title }: Tokens.Link): string {
			if (!/^https?:\/\//i.test(href)) return escapeHtml(text || href);
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer">${escapeHtml(text || href)}</a>`;
		},
	},
});

export function renderMarkdown(text: string): string {
	const cached = cache.get(text);
	if (cached !== undefined) return cached;
	const html = sanitize(String(marked.parse(text, { async: false })));
	if (cache.size >= CACHE_MAX) {
		const first = cache.keys().next().value;
		if (first !== undefined) cache.delete(first);
	}
	cache.set(text, html);
	return html;
}

function sanitize(html: string): string {
	if (typeof window === "undefined") return html;
	return DOMPurify.sanitize(html, { ADD_ATTR: ["data-lang", "target", "rel"] });
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
