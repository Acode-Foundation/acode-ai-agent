import { fetchReadable } from "./extract";
import { searchWithNative } from "./nativeSearch";
import { isAbortError, normalizeCount, throwIfAborted } from "./request";
import {
	NATIVE_SEARCH_BY_MODEL_PROVIDER,
	SearchError,
	type ResolvedSearchProvider,
	type SearchOptions,
	type SearchResponse,
	type WebSearchContext,
} from "./types";
import { searchWithWebView } from "./webviewSearch";

export function nativeProviderFor(modelProviderId: string): ResolvedSearchProvider | undefined {
	return NATIVE_SEARCH_BY_MODEL_PROVIDER[modelProviderId];
}

export function autoSearchPlan(modelProviderId: string): ResolvedSearchProvider[] {
	const native = nativeProviderFor(modelProviderId);
	return native ? [native, "webview"] : ["webview"];
}

export async function searchWeb(
	query: string,
	options: SearchOptions,
	ctx: WebSearchContext,
): Promise<SearchResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("Search query cannot be empty.");
	throwIfAborted(options.signal);
	const plan = autoSearchPlan(ctx.currentProviderId());
	const failures: string[] = [];
	for (const provider of plan) {
		throwIfAborted(options.signal);
		try {
			const response = await runProvider(provider, trimmed, options, ctx);
			if (response.results.length || response.answer.trim()) return response;
			failures.push(`${provider}: empty result`);
		} catch (error) {
			if (isAbortError(error) || (error instanceof SearchError && error.kind === "aborted")) throw error;
			failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Web search failed.\n  - ${failures.join("\n  - ")}`);
}

export async function attachPageContent(
	response: SearchResponse,
	signal?: AbortSignal,
	limit = 3,
): Promise<SearchResponse> {
	const urls = response.results.slice(0, Math.min(limit, response.results.length)).map((item) => item.url);
	if (!urls.length) return response;
	const pages = await Promise.all(urls.map((url) => fetchReadable(url, signal)));
	return { ...response, inlineContent: pages.filter((page) => page.content || page.error) };
}

async function runProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: SearchOptions,
	ctx: WebSearchContext,
): Promise<SearchResponse> {
	const next = { ...options, numResults: normalizeCount(options.numResults) };
	if (provider === "webview") return searchWithWebView(query, next);
	return searchWithNative(provider, query, next, ctx);
}
