import { hostnameOf } from "./request";
import type { ExtractedContent, SearchResponse, SearchResult } from "./types";

const SOURCE_LINE = /^(\d+)\.\s+(.+?)\s+—\s+(\S+)\s*$/;

export function formatSearchResponse(response: SearchResponse, query: string): string {
	const lines = [`Web search via ${response.provider === "webview" ? "device" : response.provider} · “${query}”`, ""];
	if (response.answer.trim()) {
		lines.push(response.answer.trim(), "");
	}
	if (!response.results.length) {
		lines.push("No sources returned.");
		return lines.join("\n").trim();
	}
	lines.push("Sources");
	for (const [index, result] of response.results.entries()) {
		lines.push(`${index + 1}. ${result.title} — ${hostnameOf(result.url)}`);
		lines.push(`   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	}
	if (response.inlineContent?.length) {
		lines.push("", "Page excerpts");
		for (const page of response.inlineContent) {
			if (!page.content || page.error) continue;
			lines.push(`### ${page.title || hostnameOf(page.url)}`);
			lines.push(page.url);
			lines.push(page.content.slice(0, 4_000));
			lines.push("");
		}
	}
	return lines.join("\n").trim();
}

export function formatFetchResponse(pages: ExtractedContent[]): string {
	return pages.map((page) => {
		if (page.error && !page.content) return `${page.url}\nError: ${page.error}`;
		const header = [page.title, page.url].filter(Boolean).join("\n");
		const body = page.content || page.error || "Empty page.";
		return `${header}\n\n${body}`;
	}).join("\n\n---\n\n");
}

export function parseWebSearchOutput(output?: string): { provider?: string; query?: string; answer?: string; results: SearchResult[] } | undefined {
	if (!output) return undefined;
	const header = /^Web search via (\S+)(?: · “(.+)”)?/.exec(output);
	const sourcesAt = output.search(/^Sources$/m);
	if (sourcesAt < 0 && !header) return undefined;
	const answer = (sourcesAt >= 0 ? output.slice(header?.[0].length ?? 0, sourcesAt) : output.slice(header?.[0].length ?? 0))
		.replace(/^\n+/, "")
		.trim();
	const results: SearchResult[] = [];
	if (sourcesAt >= 0) {
		const block = output.slice(sourcesAt).split(/\n(?=Page excerpts|\n### )/)[0] ?? "";
		const lines = block.split("\n").slice(1);
		let current: SearchResult | undefined;
		for (const line of lines) {
			const match = SOURCE_LINE.exec(line.trimEnd());
			if (match) {
				if (current) results.push(current);
				current = { title: match[2]!.trim(), url: "", snippet: "" };
				continue;
			}
			if (!current) continue;
			const trimmed = line.trim();
			if (!current.url && /^https?:\/\//i.test(trimmed)) {
				current.url = trimmed;
				continue;
			}
			if (trimmed) current.snippet = current.snippet ? `${current.snippet} ${trimmed}` : trimmed;
		}
		if (current?.url) results.push(current);
	}
	if (!results.length && !header) return undefined;
	return {
		provider: header?.[1],
		query: header?.[2],
		answer: answer || undefined,
		results,
	};
}
