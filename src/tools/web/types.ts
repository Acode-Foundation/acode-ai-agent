export type ResolvedSearchProvider = "openai" | "google" | "xai" | "anthropic" | "webview";

export const NATIVE_SEARCH_BY_MODEL_PROVIDER: Record<string, ResolvedSearchProvider> = {
	openai: "openai",
	"openai-codex": "openai",
	google: "google",
	xai: "xai",
	anthropic: "anthropic",
};

export type RecencyFilter = "day" | "week" | "month" | "year";

export type SearchResult = {
	title: string;
	url: string;
	snippet: string;
};

export type ExtractedContent = {
	url: string;
	title: string;
	content: string;
	error?: string;
};

export type SearchOptions = {
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	includeContent?: boolean;
	signal?: AbortSignal;
};

export type SearchResponse = {
	provider: ResolvedSearchProvider;
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
};

export type SearchErrorKind =
	| "aborted"
	| "auth"
	| "credential"
	| "quota"
	| "transient"
	| "network"
	| "invalid-response"
	| "unknown";

export class SearchError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly kind: SearchErrorKind;
	readonly status?: number;

	constructor(provider: ResolvedSearchProvider, kind: SearchErrorKind, message: string, status?: number) {
		super(message);
		this.name = "SearchError";
		this.provider = provider;
		this.kind = kind;
		this.status = status;
	}
}

export type WebAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
	baseUrl?: string;
	modelId: string;
};

export type WebSearchContext = {
	currentProviderId: () => string;
	currentModelId: () => string | undefined;
	resolveAuth: (providerId: string, preferredModelId?: string) => Promise<WebAuth | undefined>;
};
