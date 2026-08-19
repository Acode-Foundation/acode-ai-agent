import {
	addResult,
	classifyHttpError,
	decodeJwtPayload,
	errorMessage,
	normalizeCount,
	readErrorBody,
	splitDomainFilter,
	webRequest,
	wrapSearchError,
} from "./request";
import { SearchError, type SearchOptions, type SearchResponse, type SearchResult, type WebAuth, type WebSearchContext } from "./types";

const OPENAI_RESPONSES = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const XAI_RESPONSES = "https://api.x.ai/v1/responses";
const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages";

export async function searchWithNative(
	provider: "openai" | "google" | "xai" | "anthropic",
	query: string,
	options: SearchOptions,
	ctx: WebSearchContext,
): Promise<SearchResponse> {
	if (provider === "openai") return searchOpenAI(query, options, ctx);
	if (provider === "google") return searchGemini(query, options, ctx);
	if (provider === "xai") return searchXai(query, options, ctx);
	return searchAnthropic(query, options, ctx);
}

async function searchOpenAI(query: string, options: SearchOptions, ctx: WebSearchContext): Promise<SearchResponse> {
	const providerId = ctx.currentProviderId() === "openai-codex" ? "openai-codex" : "openai";
	const auth = await ctx.resolveAuth(providerId, ctx.currentModelId())
		?? await ctx.resolveAuth("openai")
		?? await ctx.resolveAuth("openai-codex");
	if (!auth?.apiKey) throw new SearchError("openai", "credential", "OpenAI web search needs an OpenAI or Codex credential.");

	const useCodex = providerId === "openai-codex" || isCodexJwt(auth.apiKey);
	const headers: Record<string, string> = {
		...auth.headers,
		Authorization: `Bearer ${auth.apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	};
	if (useCodex) {
		const accountId = extractAccountId(auth.apiKey);
		if (accountId) headers["chatgpt-account-id"] = accountId;
		headers.originator = "acode-ai-agent";
	}

	const filters = splitDomainFilter(options.domainFilter);
	const tool: Record<string, unknown> = { type: "web_search" };
	if (filters.allowed.length || filters.blocked.length) {
		tool.filters = {
			...(filters.allowed.length ? { allowed_domains: filters.allowed.slice(0, 20) } : {}),
			...(filters.blocked.length ? { blocked_domains: filters.blocked.slice(0, 20) } : {}),
		};
	}

	try {
		const response = await webRequest(useCodex ? CODEX_RESPONSES : (auth.baseUrl ? `${auth.baseUrl.replace(/\/$/, "")}/responses` : OPENAI_RESPONSES), {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: auth.modelId,
				instructions: searchInstructions(options),
				input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
				tools: [tool],
				include: ["web_search_call.action.sources"],
				store: false,
				stream: true,
				tool_choice: "required",
			}),
			signal: options.signal,
		});
		if (!response.ok) {
			const body = await readErrorBody(response, auth.apiKey);
			throw new SearchError("openai", classifyHttpError(response.status, body), `OpenAI search error ${response.status}: ${body}`, response.status);
		}
		const parsed = parseResponsesBody(await response.text());
		const results = extractResponseSources(parsed, options.numResults);
		const answer = extractResponseAnswer(parsed);
		if (!answer && !results.length) throw new SearchError("openai", "invalid-response", "OpenAI web search returned no answer or sources.");
		return { provider: "openai", answer, results };
	} catch (error) {
		throw wrapSearchError("openai", error, auth.apiKey);
	}
}

async function searchGemini(query: string, options: SearchOptions, ctx: WebSearchContext): Promise<SearchResponse> {
	const auth = await ctx.resolveAuth("google", ctx.currentModelId());
	if (!auth?.apiKey) throw new SearchError("google", "credential", "Gemini web search needs a Google AI Studio key.");
	const model = sanitizeGeminiModel(auth.modelId);
	const endpoint = `${(auth.baseUrl || GEMINI_BASE).replace(/\/$/, "")}/models/${model}:generateContent`;
	try {
		const response = await webRequest(endpoint, {
			method: "POST",
			headers: {
				...auth.headers,
				"Content-Type": "application/json",
				"x-goog-api-key": auth.apiKey,
			},
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: `${searchInstructions(options)}\n\n${query}` }] }],
				tools: [{ google_search: {} }],
			}),
			signal: options.signal,
		});
		if (!response.ok) {
			const body = await readErrorBody(response, auth.apiKey);
			throw new SearchError("google", classifyHttpError(response.status, body), `Gemini search error ${response.status}: ${body}`, response.status);
		}
		const data = await response.json() as {
			candidates?: Array<{
				content?: { parts?: Array<{ text?: string }> };
				groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
			}>;
		};
		const answer = data.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n") ?? "";
		const results: SearchResult[] = [];
		const seen = new Set<string>();
		for (const chunk of data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
			addResult(results, seen, chunk.web?.uri, chunk.web?.title);
			if (results.length >= normalizeCount(options.numResults)) break;
		}
		if (!answer && !results.length) throw new SearchError("google", "invalid-response", "Gemini search returned no answer or sources.");
		return { provider: "google", answer, results };
	} catch (error) {
		throw wrapSearchError("google", error, auth.apiKey);
	}
}

async function searchXai(query: string, options: SearchOptions, ctx: WebSearchContext): Promise<SearchResponse> {
	const auth = await ctx.resolveAuth("xai", ctx.currentModelId());
	if (!auth?.apiKey) throw new SearchError("xai", "credential", "xAI web search needs a Grok API key or subscription.");
	try {
		const response = await webRequest(auth.baseUrl ? `${auth.baseUrl.replace(/\/$/, "")}/responses` : XAI_RESPONSES, {
			method: "POST",
			headers: {
				...auth.headers,
				Authorization: `Bearer ${auth.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: auth.modelId,
				input: `${searchInstructions(options)}\n\n${query}`,
				tools: [{ type: "web_search" }],
			}),
			signal: options.signal,
		});
		if (!response.ok) {
			const body = await readErrorBody(response, auth.apiKey);
			throw new SearchError("xai", classifyHttpError(response.status, body), `xAI search error ${response.status}: ${body}`, response.status);
		}
		const parsed = parseResponsesBody(await response.text());
		const results = extractResponseSources(parsed, options.numResults);
		const answer = extractResponseAnswer(parsed);
		if (!answer && !results.length) throw new SearchError("xai", "invalid-response", "xAI web search returned no answer or sources.");
		return { provider: "xai", answer, results };
	} catch (error) {
		throw wrapSearchError("xai", error, auth.apiKey);
	}
}

async function searchAnthropic(query: string, options: SearchOptions, ctx: WebSearchContext): Promise<SearchResponse> {
	const auth = await ctx.resolveAuth("anthropic", ctx.currentModelId());
	if (!auth?.apiKey) throw new SearchError("anthropic", "credential", "Anthropic web search needs an Anthropic API key.");
	try {
		const response = await webRequest(auth.baseUrl ? `${auth.baseUrl.replace(/\/$/, "")}/v1/messages` : ANTHROPIC_MESSAGES, {
			method: "POST",
			headers: {
				...auth.headers,
				"x-api-key": auth.apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: auth.modelId,
				max_tokens: 2048,
				tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
				messages: [{ role: "user", content: `${searchInstructions(options)}\n\n${query}` }],
			}),
			signal: options.signal,
		});
		if (!response.ok) {
			const body = await readErrorBody(response, auth.apiKey);
			throw new SearchError("anthropic", classifyHttpError(response.status, body), `Anthropic search error ${response.status}: ${body}`, response.status);
		}
		const data = await response.json() as { content?: Array<Record<string, unknown>> };
		const results: SearchResult[] = [];
		const seen = new Set<string>();
		const answers: string[] = [];
		for (const block of data.content ?? []) {
			if (block.type === "text" && typeof block.text === "string") {
				answers.push(block.text);
				const citations = (block as { citations?: Array<Record<string, unknown>> }).citations ?? [];
				for (const citation of citations) {
					addResult(results, seen, citation.url, citation.title, typeof citation.cited_text === "string" ? citation.cited_text : "");
				}
			}
			if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
				for (const item of block.content) {
					if (!item || typeof item !== "object") continue;
					const record = item as Record<string, unknown>;
					addResult(results, seen, record.url, record.title, typeof record.page_age === "string" ? record.page_age : "");
				}
			}
		}
		if (!answers.length && !results.length) throw new SearchError("anthropic", "invalid-response", "Anthropic web search returned no answer or sources.");
		return { provider: "anthropic", answer: answers.join("\n").trim(), results: results.slice(0, normalizeCount(options.numResults)) };
	} catch (error) {
		throw wrapSearchError("anthropic", error, auth.apiKey);
	}
}

function searchInstructions(options: SearchOptions): string {
	const lines = [
		"Search the web and return a concise, cited answer grounded only in the results.",
		"Prefer official documentation and recent primary sources.",
	];
	if (options.recencyFilter) {
		const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}
	const filters = splitDomainFilter(options.domainFilter);
	if (filters.allowed.length) lines.push(`Only use sources from: ${filters.allowed.join(", ")}.`);
	if (filters.blocked.length) lines.push(`Do not use sources from: ${filters.blocked.join(", ")}.`);
	return lines.join(" ");
}

function parseResponsesBody(text: string): unknown[] {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) return parsed;
			if (parsed && typeof parsed === "object" && Array.isArray((parsed as { output?: unknown }).output)) {
				return (parsed as { output: unknown[] }).output;
			}
		} catch (error) {
			throw new Error(`Invalid JSON: ${errorMessage(error)}`);
		}
	}
	const items: unknown[] = [];
	let completed: unknown[] | undefined;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as Record<string, unknown>;
			if (parsed.type === "response.output_item.done" && parsed.item) items.push(parsed.item);
			if ((parsed.type === "response.done" || parsed.type === "response.completed") && parsed.response && typeof parsed.response === "object") {
				const output = (parsed.response as { output?: unknown }).output;
				if (Array.isArray(output) && output.length) completed = output;
			}
		} catch {
			// Ignore malformed SSE chunks.
		}
	}
	if (completed?.length) return completed;
	if (items.length) return items;
	throw new Error("No parseable response output");
}

function extractResponseAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
				parts.push((part as { text: string }).text);
			}
		}
	}
	return parts.join("\n").trim();
}

function extractResponseSources(output: unknown[], numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
			for (const annotation of Array.isArray((part as { annotations?: unknown }).annotations) ? (part as { annotations: unknown[] }).annotations : []) {
				if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
				const record = annotation as { url?: unknown; title?: unknown; start_index?: unknown; end_index?: unknown };
				addResult(results, seen, record.url, record.title, snippetAround(text, record.start_index, record.end_index));
			}
		}
	}
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") continue;
		const value = item as { action?: { sources?: unknown }; sources?: unknown; results?: unknown };
		for (const group of [value.action?.sources, value.sources, value.results]) {
			if (!Array.isArray(group)) continue;
			for (const source of group) {
				if (!source || typeof source !== "object") continue;
				const record = source as Record<string, unknown>;
				addResult(results, seen, record.url ?? record.source_website_url, record.title ?? record.caption);
			}
		}
	}
	return results.slice(0, normalizeCount(numResults));
}

function snippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const slice = text.slice(Math.max(0, start - 80), Math.min(text.length, end + 80)).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	return slice.length > 280 ? `${slice.slice(0, 277)}…` : slice;
}

function isCodexJwt(token: string): boolean {
	return Boolean(decodeJwtPayload(token)?.["https://api.openai.com/auth"]);
}

function extractAccountId(token: string): string | undefined {
	const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const id = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
	return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function sanitizeGeminiModel(modelId: string): string {
	return modelId.replace(/^models\//, "") || "gemini-2.5-flash";
}

export function authFromResolved(auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }, modelId: string): WebAuth {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(auth.headers ?? {})) {
		if (typeof value === "string") headers[key] = value;
	}
	return { apiKey: auth.apiKey, headers, baseUrl: auth.baseUrl, modelId };
}
