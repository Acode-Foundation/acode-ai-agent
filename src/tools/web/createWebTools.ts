import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fetchReadable } from "./extract";
import { formatFetchResponse, formatSearchResponse } from "./format";
import { attachPageContent, searchWeb } from "./router";
import { throwIfAborted } from "./request";
import type { RecencyFilter, WebSearchContext } from "./types";

type ToolDetails = {
	operation: "web_search" | "fetch_content";
	provider?: string;
	query?: string;
	path?: string;
	count?: number;
};

type ToolResult = AgentToolResult<ToolDetails>;

export function createWebTools(ctx: WebSearchContext): AgentTool<any>[] {
	const webSearch: AgentTool<any> = {
		name: "web_search",
		label: "Web search",
		description:
			"Search the live web for current documentation, APIs, package versions, news, and citations. " +
			"Uses the model host's search when it has one, otherwise the device browser. Use fetch_content to read a specific page.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query" })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Batch of queries, run in order" })),
			num_results: Type.Optional(Type.Number({ description: "Results per query, 1-10, default 5" })),
			recency: Type.Optional(Type.String({ description: "day | week | month | year" })),
			domains: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude" })),
			include_content: Type.Optional(Type.Boolean({ description: "Fetch short excerpts from the top sources" })),
		}),
		executionMode: "parallel",
		execute: async (_id, params, signal, onUpdate) => {
			const input = params as {
				query?: string;
				queries?: string[];
				num_results?: number;
				recency?: string;
				domains?: string[];
				include_content?: boolean;
			};
			const queries = normalizeQueries(input.query, input.queries);
			if (!queries.length) throw new Error("Provide query or queries.");
			const recency = asRecency(input.recency);
			const chunks: string[] = [];
			let lastProvider = "";
			let total = 0;
			for (const query of queries) {
				throwIfAborted(signal);
				onUpdate?.(result(`Searching “${query}”…`, { operation: "web_search", query }));
				let response = await searchWeb(query, {
					numResults: input.num_results,
					recencyFilter: recency,
					domainFilter: input.domains,
					includeContent: input.include_content,
					signal,
				}, ctx);
				if (input.include_content) response = await attachPageContent(response, signal);
				lastProvider = response.provider;
				total += response.results.length;
				chunks.push(formatSearchResponse(response, query));
			}
			return result(chunks.join("\n\n---\n\n"), {
				operation: "web_search",
				provider: lastProvider,
				query: queries.join(" · "),
				count: total,
			});
		},
	};

	const fetchContent: AgentTool<any> = {
		name: "fetch_content",
		label: "Fetch page",
		description:
			"Fetch a public http(s) URL as readable markdown. GitHub blob URLs are rewritten to raw file contents. " +
			"Uses the device browser when the direct fetch is blocked or too thin.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Page URL" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs" })),
		}),
		executionMode: "parallel",
		execute: async (_id, params, signal, onUpdate) => {
			const input = params as { url?: string; urls?: string[] };
			const urls = [...(input.url ? [input.url] : []), ...(input.urls ?? [])].map((value) => value.trim()).filter(Boolean);
			if (!urls.length) throw new Error("Provide url or urls.");
			const pages = [];
			for (const url of urls.slice(0, 6)) {
				throwIfAborted(signal);
				onUpdate?.(result(`Fetching ${url}…`, { operation: "fetch_content", path: url }));
				pages.push(await fetchReadable(url, signal));
			}
			const ok = pages.filter((page) => page.content && !page.error).length;
			return result(formatFetchResponse(pages), {
				operation: "fetch_content",
				path: urls[0],
				count: ok,
			});
		},
	};

	return [webSearch, fetchContent];
}

function result(content: string, details: ToolDetails): ToolResult {
	return { content: [{ type: "text", text: content }], details };
}

function normalizeQueries(query?: string, queries?: string[]): string[] {
	const values = [...(queries ?? []), ...(query ? [query] : [])];
	const seen = new Set<string>();
	const next: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		next.push(trimmed);
		if (next.length >= 4) break;
	}
	return next;
}

function asRecency(value?: string): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}
