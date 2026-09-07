import { createProvider, type ApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { nativeFetch } from "../platform/nativeHttp";
import { sanitizeModelId } from "./customModels";

/** Must stay aligned with `PROVIDERS` in providerRegistry.ts. */
export const BUILTIN_PROVIDER_IDS = [
	"openrouter", "openai", "openai-codex", "anthropic", "github-copilot", "google", "xai", "groq",
	"deepseek", "cerebras", "fireworks", "together", "moonshotai", "minimax", "zai", "kimi-coding",
	"qwen-token-plan", "ant-ling", "xiaomi",
] as const;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_ENDPOINTS = 20;
const MAX_MODELS = 50;
const FETCH_TIMEOUT_MS = 8_000;

export type CustomEndpoint = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	fetchModels: boolean;
	vision: boolean;
	reasoning: boolean;
	localCompat: boolean;
};

export type CustomEndpointDraft = {
	id?: string;
	name: string;
	baseUrl: string;
	models?: string[] | string;
	fetchModels?: boolean;
	vision?: boolean;
	reasoning?: boolean;
	localCompat?: boolean;
};

const RESERVED_PROVIDER_IDS = new Set<string>(BUILTIN_PROVIDER_IDS);

/** Typical OpenAI-compatible local servers. Replace the LAN IP with the machine running the server. */
export const LOCAL_ENDPOINT_PRESETS = [
	{ name: "llama.cpp", baseUrl: "http://192.168.1.10:8080/v1" },
	{ name: "vLLM", baseUrl: "http://192.168.1.10:8000/v1" },
	{ name: "LM Studio", baseUrl: "http://192.168.1.10:1234/v1" },
	{ name: "Ollama", baseUrl: "http://192.168.1.10:11434/v1" },
] as const;

export const LOCAL_OPENAI_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
} as const;

export function isReservedProviderId(id: string): boolean {
	return RESERVED_PROVIDER_IDS.has(id);
}

export function isLoopbackUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "::1";
	} catch {
		return false;
	}
}

export function isLocalUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
		if (host.endsWith(".local")) return true;
		if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
		if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
		if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
		const match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
		if (match) {
			const second = Number(match[1]);
			return second >= 16 && second <= 31;
		}
		return false;
	} catch {
		return false;
	}
}

export function normalizeOpenAIBaseUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 500) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	if (parsed.username || parsed.password) return undefined;
	if (parsed.search || parsed.hash) return undefined;
	if (!parsed.hostname || parsed.hostname === "0.0.0.0") return undefined;
	let path = parsed.pathname.replace(/\/+$/, "");
	path = path.replace(/\/(chat\/)?completions$/i, "");
	if (!path || path === "/") path = "/v1";
	return `${parsed.protocol}//${parsed.host}${path}`;
}

export function slugifyProviderId(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return PROVIDER_ID.test(slug) ? slug : "custom";
}

export function allocateProviderId(name: string, taken: Iterable<string>, preferred?: string): string {
	const used = new Set([...RESERVED_PROVIDER_IDS, ...taken]);
	const preferredId = preferred?.trim().toLowerCase();
	const base = preferredId && PROVIDER_ID.test(preferredId) && !RESERVED_PROVIDER_IDS.has(preferredId)
		? preferredId
		: slugifyProviderId(name);
	if (!used.has(base)) return base;
	for (let n = 2; n < 100; n++) {
		const candidate = `${base.slice(0, 60)}-${n}`;
		if (!used.has(candidate)) return candidate;
	}
	throw new Error("Could not allocate a unique provider id.");
}

export function parseModelIdList(value: unknown): string[] {
	const raw = Array.isArray(value)
		? value.map((item) => String(item ?? ""))
		: typeof value === "string"
			? value.split(/[\n,]+/)
			: [];
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const id = sanitizeModelId(item);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		unique.push(id);
		if (unique.length >= MAX_MODELS) break;
	}
	return unique;
}

export function parseOpenAIModelIds(payload: unknown): string[] {
	const rows = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object"
			? Array.isArray((payload as { data?: unknown }).data)
				? (payload as { data: unknown[] }).data
				: Array.isArray((payload as { models?: unknown }).models)
					? (payload as { models: unknown[] }).models
					: []
			: [];
	return parseModelIdList(rows.map((row) => {
		if (typeof row === "string") return row;
		if (!row || typeof row !== "object") return "";
		const record = row as { id?: unknown; name?: unknown; model?: unknown };
		if (typeof record.id === "string") return record.id;
		if (typeof record.name === "string") return record.name;
		if (typeof record.model === "string") return record.model;
		return "";
	}));
}

export function sanitizeCustomEndpoint(value: unknown, taken: Iterable<string> = []): CustomEndpoint | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name.trim().slice(0, 80) : "";
	const baseUrl = typeof record.baseUrl === "string" ? normalizeOpenAIBaseUrl(record.baseUrl) : undefined;
	if (!name || !baseUrl) return undefined;
	const existingId = typeof record.id === "string" ? record.id.trim().toLowerCase() : undefined;
	if (existingId && (!PROVIDER_ID.test(existingId) || isReservedProviderId(existingId))) return undefined;
	const id = existingId && ![...taken].includes(existingId)
		? existingId
		: allocateProviderId(name, taken, existingId);
	return {
		id,
		name,
		baseUrl,
		models: parseModelIdList(record.models),
		fetchModels: record.fetchModels !== false,
		vision: record.vision !== false,
		reasoning: record.reasoning !== false,
		localCompat: record.localCompat !== false,
	};
}

export function sanitizeCustomEndpoints(value: unknown): CustomEndpoint[] {
	if (!Array.isArray(value)) return [];
	const endpoints: CustomEndpoint[] = [];
	const taken: string[] = [];
	for (const item of value) {
		if (endpoints.length >= MAX_ENDPOINTS) break;
		const endpoint = sanitizeCustomEndpoint(item, taken);
		if (!endpoint) continue;
		taken.push(endpoint.id);
		endpoints.push(endpoint);
	}
	return endpoints;
}

export function finalizeCustomEndpoint(draft: CustomEndpointDraft, existing: readonly CustomEndpoint[]): CustomEndpoint {
	const name = draft.name.trim().slice(0, 80);
	if (!name) throw new Error("Enter a name for this endpoint.");
	const baseUrl = normalizeOpenAIBaseUrl(draft.baseUrl);
	if (!baseUrl) throw new Error("Enter an http(s) base URL like http://192.168.1.10:11434/v1");
	const taken = existing.filter((endpoint) => endpoint.id !== draft.id).map((endpoint) => endpoint.id);
	const current = draft.id ? existing.find((endpoint) => endpoint.id === draft.id) : undefined;
	if (draft.id && !current) throw new Error("That custom endpoint no longer exists.");
	const id = current?.id ?? allocateProviderId(name, taken, draft.id);
	if (isReservedProviderId(id)) throw new Error("That name is reserved for a built-in provider.");
	return {
		id,
		name,
		baseUrl,
		models: parseModelIdList(draft.models),
		fetchModels: draft.fetchModels !== false,
		vision: draft.vision !== false,
		reasoning: draft.reasoning !== false,
		localCompat: draft.localCompat !== false,
	};
}

export function upsertCustomEndpoint(existing: readonly CustomEndpoint[], endpoint: CustomEndpoint): CustomEndpoint[] {
	const next = existing.filter((item) => item.id !== endpoint.id);
	next.unshift(endpoint);
	return next.slice(0, MAX_ENDPOINTS);
}

export function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export async function probeOpenAIModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
	const url = normalizeOpenAIBaseUrl(baseUrl);
	if (!url) throw new Error("Enter a valid OpenAI-compatible base URL first.");
	const headers: Record<string, string> = { Accept: "application/json" };
	const key = apiKey?.trim();
	if (key && key !== "none") headers.Authorization = `Bearer ${key}`;
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS);
	const abort = () => timeout.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) timeout.abort();
	try {
		const response = await nativeFetch(modelsUrl(url), { headers, signal: timeout.signal });
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(probeError(url, response.status, detail));
		}
		const ids = parseOpenAIModelIds(await response.json());
		if (!ids.length) throw new Error(`${url}/models returned no usable model ids.`);
		return ids;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw new Error("The /models request timed out or was cancelled.");
		}
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export function customEndpointModel(endpoint: CustomEndpoint, modelId: string): Model<"openai-completions"> {
	const id = sanitizeModelId(modelId) ?? modelId;
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: endpoint.id,
		baseUrl: endpoint.baseUrl,
		reasoning: endpoint.reasoning,
		input: endpoint.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		compat: endpoint.localCompat ? { ...LOCAL_OPENAI_COMPAT } : undefined,
	};
}

export function createOpenAICompatibleProvider(endpoint: CustomEndpoint): Provider<"openai-completions"> {
	return createProvider({
		id: endpoint.id,
		name: endpoint.name,
		baseUrl: endpoint.baseUrl,
		auth: { apiKey: customEndpointAuth(endpoint) },
		models: endpoint.models.map((id) => customEndpointModel(endpoint, id)),
		api: openAICompletionsApi(),
	});
}

function customEndpointAuth(endpoint: CustomEndpoint): ApiKeyAuth {
	const name = `${endpoint.name} API key`;
	return {
		name,
		login: async (interaction) => {
			const key = await interaction.prompt({
				type: "secret",
				message: `Enter ${name}`,
				placeholder: isLocalUrl(endpoint.baseUrl) ? "optional for local servers" : "sk-…",
			});
			return { type: "api_key", key };
		},
		resolve: async ({ credential }) => {
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			if (isLocalUrl(endpoint.baseUrl)) return { auth: { apiKey: "none" }, source: "keyless" };
			return undefined;
		},
	};
}

function probeError(baseUrl: string, status: number, detail: string): string {
	const snippet = detail.replace(/\s+/g, " ").trim().slice(0, 160);
	const suffix = snippet ? `: ${snippet}` : ".";
	if (isLoopbackUrl(baseUrl)) {
		return `GET ${baseUrl}/models returned HTTP ${status}${suffix} On Android, localhost is this phone — use your computer's LAN IP for llama.cpp, vLLM, LM Studio, or Ollama.`;
	}
	return `GET ${baseUrl}/models returned HTTP ${status}${suffix}`;
}
