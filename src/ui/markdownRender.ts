import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";

const cache = new Map<string, string>();
const CACHE_MAX = 200;

const ALERT_LABELS: Record<string, string> = {
	note: "Note",
	tip: "Tip",
	important: "Important",
	warning: "Warning",
	caution: "Caution",
};

const FENCE_TITLE_ATTR = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

marked.use({
	gfm: true,
	breaks: true,
	renderer: {
		code({ text, lang, raw }: Tokens.Code): string {
			if (!text.trim()) return "";
			const info = fenceInfo(raw, lang);
			const langAttr = info.lang ? ` data-lang="${escapeHtml(info.lang)}"` : "";
			const title = info.title || info.lang || "code";
			return [
				`<figure class="md-code is-wrap"${langAttr}>`,
				`<figcaption class="md-code-head">`,
				`<span class="md-code-lang">${escapeHtml(title)}</span>`,
				`<span class="md-code-actions">`,
				`<button type="button" class="md-code-action is-on" data-wrap aria-label="Unwrap code" aria-pressed="true" title="Unwrap">`,
				`<span class="md-code-icon md-code-icon-wrap" aria-hidden="true"></span>`,
				`</button>`,
				`<button type="button" class="md-code-action md-code-copy" data-copy aria-label="Copy code" title="Copy">`,
				`<span class="md-code-icons" aria-hidden="true">`,
				`<span class="md-code-icon md-code-icon-copy"></span>`,
				`<span class="md-code-icon md-code-icon-check"></span>`,
				`</span>`,
				`</button>`,
				`</span>`,
				`</figcaption>`,
				`<pre><code>${escapeHtml(text)}</code></pre>`,
				`</figure>\n`,
			].join("");
		},
		blockquote({ text }: Tokens.Blockquote): string {
			const match = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i);
			if (!match) {
				return `<blockquote>${String(marked.parse(text, { async: false }))}</blockquote>\n`;
			}
			const kind = match[1]!.toLowerCase();
			const body = text.slice(match[0].length);
			const inner = body.trim() ? String(marked.parse(body, { async: false })) : "";
			return `<aside class="md-alert md-alert--${kind}" role="note"><p class="md-alert-title">${ALERT_LABELS[kind] ?? kind}</p>${inner}</aside>\n`;
		},
		link({ href, text, title }: Tokens.Link): string {
			const label = escapeHtml(text || href);
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			const kind = classifyMarkdownRef(href);
			if (kind === "web") {
				return referenceChip("web", escapeHtml(href), label, titleAttr);
			}
			if (kind === "file") {
				const path = escapeHtml(stripHrefMetadata(href));
				return referenceChip("file", path, label, `${titleAttr} data-path="${path}"`);
			}
			if (kind === "plain" && (/^(mailto|tel|sms):/i.test(href) || href.startsWith("#"))) {
				return `<a href="${escapeHtml(href)}"${titleAttr}>${label}</a>`;
			}
			return label;
		},
		image({ href, text, title }: Tokens.Image): string {
			if (!/^https?:\/\//i.test(href)) return escapeHtml(text || "");
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<img class="md-image" src="${escapeHtml(href)}" alt="${escapeHtml(text || "")}"${titleAttr} loading="lazy">`;
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
	return DOMPurify.sanitize(html, {
		ADD_TAGS: ["figure", "figcaption", "aside", "input"],
		ADD_ATTR: ["data-lang", "data-path", "data-kind", "data-copy", "data-wrap", "target", "rel", "disabled", "checked", "type"],
	});
}

function referenceChip(kind: "web" | "file", href: string, label: string, extraAttrs: string): string {
	return [
		`<a class="md-ref md-ref--${kind}" href="${href}" data-kind="${kind}"${extraAttrs}>`,
		`<span class="md-ref-icon" aria-hidden="true"></span>`,
		`<span class="md-ref-label">${label}</span>`,
		`</a>`,
	].join("");
}

function fenceInfo(raw: string, lang: string | undefined): { lang: string; title: string } {
	const info = raw.match(/^`{3,}([^\n]*)/)?.[1]?.trim() ?? lang ?? "";
	const tokens = info.split(/\s+/).filter(Boolean);
	const language = (tokens[0] ?? lang ?? "").replace(/[^\w.+#-]/g, "").slice(0, 32);
	const rest = tokens.slice(1).join(" ");
	const attr = FENCE_TITLE_ATTR.exec(rest);
	const titled = attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? "";
	const filename = tokens.slice(1).find((token) => FENCE_FILENAME.test(token)) ?? "";
	return { lang: language, title: titled || filename };
}

function classifyMarkdownRef(href: string): "web" | "file" | "plain" {
	if (/^https?:\/\//i.test(href)) return "web";
	if (/^(mailto|tel|sms|javascript):/i.test(href) || href.startsWith("#")) return "plain";
	if (/^file:\/\//i.test(href)) return "file";
	const path = stripHrefMetadata(href);
	const fileName = path.split(/[/\\]/).filter(Boolean).at(-1) || "";
	if (!fileName || fileName === "." || fileName === "..") return "plain";
	if (/[/\\]/.test(path) || /\.[\w]{1,12}$/.test(fileName)) return "file";
	return "plain";
}

function stripHrefMetadata(href: string): string {
	return href
		.replace(/^file:\/\//i, "")
		.split(/[?#]/, 1)[0]
		.replace(/:\d+(?::\d+)?$/, "");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
