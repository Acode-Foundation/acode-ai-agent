import { FETCH_TIMEOUT_MS, hostnameOf, readErrorBody, webRequest } from "./request";
import { assertPublicHttpUrl, rewriteGithubBlob } from "./ssrf";
import type { ExtractedContent } from "./types";
import { fetchViaWebView } from "./webviewSearch";

const MAX_INLINE_CHARS = 24_000;
const THIN_CONTENT = 400;
const BLOCKED_HINT = /just a moment|enable javascript|attention required|verify you are human|captcha|access denied|cf-browser-verification|checking your browser/i;

export async function fetchReadable(rawUrl: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const url = rewriteGithubBlob(assertPublicHttpUrl(rawUrl));
	try {
		const direct = await fetchDirect(url, signal);
		if (direct.content.length >= THIN_CONTENT && !BLOCKED_HINT.test(direct.content)) return direct;
		const viaWeb = await fetchViaWebView(url, signal).catch(() => undefined);
		if (viaWeb && viaWeb.content.length > direct.content.length) return viaWeb;
		return viaWeb?.content ? viaWeb : direct;
	} catch (error) {
		const viaWeb = await fetchViaWebView(url, signal).catch(() => undefined);
		if (viaWeb?.content) return viaWeb;
		return {
			url,
			title: hostnameOf(url),
			content: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function htmlToReadable(html: string, url: string): { title: string; content: string } {
	const title = decodeEntities(
		html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
			?? html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
			?? hostnameOf(url),
	).replace(/\s+/g, " ").trim();
	const article = pickArticle(html);
	const markdown = tagsToMarkdown(stripNoise(article));
	return { title: title || hostnameOf(url), content: collapseBlank(markdown).slice(0, MAX_INLINE_CHARS) };
}

async function fetchDirect(url: string, signal?: AbortSignal): Promise<ExtractedContent> {
	const response = await webRequest(url, {
		method: "GET",
		headers: {
			Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
			"User-Agent": "AcodeAIAgent/0.1 (+https://acode.app)",
		},
		timeoutMs: FETCH_TIMEOUT_MS,
		signal,
	});
	if (!response.ok) {
		throw new Error(`Fetch failed ${response.status}: ${await readErrorBody(response)}`);
	}
	const body = (await response.text()).slice(0, 1_500_000);
	const type = response.headers.get("content-type") ?? "";
	if (/json|javascript|xml|markdown|plain/i.test(type) && !/html/i.test(type)) {
		return { url, title: hostnameOf(url), content: collapseBlank(body).slice(0, MAX_INLINE_CHARS) };
	}
	if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
		return { url, title: hostnameOf(url), content: collapseBlank(body).slice(0, MAX_INLINE_CHARS) };
	}
	const readable = htmlToReadable(body, url);
	return { url, title: readable.title, content: readable.content };
}

function pickArticle(html: string): string {
	const cleaned = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
	let best = "";
	let bestScore = 0;
	for (const tag of ["article", "main"]) {
		for (const match of cleaned.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))) {
			const chunk = match[1] ?? "";
			const score = chunk.length + (chunk.match(/<p\b/gi)?.length ?? 0) * 400 + (chunk.match(/<h[1-3]\b/gi)?.length ?? 0) * 200;
			if (score > bestScore) {
				best = chunk;
				bestScore = score;
			}
		}
	}
	if (best.length > 200) return best;
	return cleaned.replace(/<\/?(?:html|head|body|header|footer|nav|aside)[^>]*>/gi, "\n");
}

function stripNoise(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<(?:svg|iframe|canvas|form|button|input|nav|footer|header)\b[\s\S]*?<\/(?:svg|iframe|canvas|form|button|nav|footer|header)>/gi, " ")
		.replace(/<(?:img|br|hr|meta|link|input)[^>]*>/gi, "\n");
}

function tagsToMarkdown(html: string): string {
	return decodeEntities(
		html
			.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n${"#".repeat(Number(level))} ${plain(text)}\n`)
			.replace(/<(?:p|div|section|li|tr)\b[^>]*>/gi, "\n")
			.replace(/<\/(?:p|div|section|li|tr)>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
			.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
			.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
			.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, text) => `\n\`\`\`\n${plain(text)}\n\`\`\`\n`)
			.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
				const label = plain(text).trim();
				return label ? `[${label}](${href})` : href;
			})
			.replace(/<[^>]+>/g, " "),
	);
}

function plain(value: string): string {
	return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function collapseBlank(value: string): string {
	return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}
