import { nativeFetch } from "../../platform/nativeHttp";
import { SearchError, type ResolvedSearchProvider, type SearchErrorKind } from "./types";

export const SEARCH_TIMEOUT_MS = 45_000;
export const FETCH_TIMEOUT_MS = 25_000;

export function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = timeoutSignal(timeoutMs);
	if (!signal) return timeout;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
	return mergeSignals(signal, timeout);
}

export function timeoutSignal(timeoutMs: number): AbortSignal {
	if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
	controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	return controller.signal;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	const message = errorMessage(error).toLowerCase();
	return message.includes("abort") || message.includes("timed out") || message.includes("timeout");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function redactSecret(text: string, secret?: string): string {
	if (!secret || secret.length < 6) return text;
	return text.split(secret).join("[redacted]");
}

export async function webRequest(
	url: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = SEARCH_TIMEOUT_MS, signal, ...rest } = init;
	return nativeFetch(url, { ...rest, signal: combineSignals(signal ?? undefined, timeoutMs) });
}

export async function readErrorBody(response: Response, secret?: string): Promise<string> {
	try {
		return redactSecret((await response.text()).slice(0, 300), secret);
	} catch {
		return "";
	}
}

export function classifyHttpError(status: number, body: string): SearchErrorKind {
	const lower = body.toLowerCase();
	if (status === 401 || status === 403) return /quota|credit|limit|billing/.test(lower) ? "quota" : "auth";
	if (status === 402 || status === 429) return "quota";
	if (status === 408 || status === 425 || status >= 500) return "transient";
	if (/rate limit|quota|too many requests/.test(lower)) return "quota";
	if (/invalid json|empty response|no parseable/.test(lower)) return "invalid-response";
	return "unknown";
}

export function wrapSearchError(
	provider: ResolvedSearchProvider,
	error: unknown,
	secret?: string,
): SearchError {
	if (error instanceof SearchError) return error;
	if (isAbortError(error)) return new SearchError(provider, "aborted", "Search was cancelled.");
	const message = redactSecret(errorMessage(error), secret);
	const status = Number(/\b(?:error|status|http)\s+(\d{3})\b/i.exec(message)?.[1] ?? Number.NaN);
	const kind = Number.isFinite(status)
		? classifyHttpError(status, message)
		: /fetch failed|network|failed to fetch|econnreset|enotfound|etimedout/.test(message.toLowerCase())
			? "network"
			: /api key|credential|not configured|unavailable/.test(message.toLowerCase())
				? "credential"
				: "unknown";
	return new SearchError(provider, kind, message, Number.isFinite(status) ? status : undefined);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length < 2 || !parts[1]) return null;
	try {
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		const decoded = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded) as unknown;
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

export function normalizeCount(value: unknown, fallback = 5): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(1, Math.min(Math.floor(number), 10));
}

export function addResult(
	results: Array<{ title: string; url: string; snippet: string }>,
	seen: Set<string>,
	url: unknown,
	title: unknown,
	snippet = "",
): void {
	if (typeof url !== "string" || !url.trim()) return;
	const clean = cleanUrl(url.trim());
	if (!clean || seen.has(clean)) return;
	seen.add(clean);
	results.push({
		title: typeof title === "string" && title.trim() ? title.trim() : hostnameOf(clean) || clean,
		url: clean,
		snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 420),
	});
}

const JUNK_HOST = /^(?:www\.)?(?:duckduckgo\.com|bing\.com|google\.com|googleadservices\.com|doubleclick\.net|yahoo\.com|yandex\.(?:com|ru)|baidu\.com)$/i;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|spm$|si$|ved$|oq$|source$|sclient$)/i;

export function cleanUrl(value: string): string {
	try {
		let url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		const wrapped = url.searchParams.get("uddg")
			?? url.searchParams.get("udg")
			?? (url.pathname.includes("/ck/") ? url.searchParams.get("u") : null);
		if (wrapped) {
			try {
				url = new URL(wrapped);
			} catch {
				// Keep the outer URL.
			}
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		if (JUNK_HOST.test(url.hostname)) return "";
		if (/\/(?:aclick|aclk|pagead)\b/i.test(url.pathname)) return "";
		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
		}
		url.hash = "";
		return url.toString();
	} catch {
		return "";
	}
}

export function hostnameOf(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, "");
	} catch {
		return value;
	}
}

export function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		input = (input.includes("://") ? new URL(input) : new URL(`https://${input}`)).hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

export function splitDomainFilter(domainFilter: string[] | undefined): { allowed: string[]; blocked: string[] } {
	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blocked : allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return { allowed, blocked };
}

export function matchesDomainFilters(url: string, filters: { allowed: string[]; blocked: string[] }): boolean {
	if (!filters.allowed.length && !filters.blocked.length) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.allowed.length && !filters.allowed.some(matches)) return false;
	return !filters.blocked.some(matches);
}

function mergeSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
	if (left.aborted) return left;
	if (right.aborted) return right;
	const controller = new AbortController();
	const abort = () => controller.abort();
	left.addEventListener("abort", abort, { once: true });
	right.addEventListener("abort", abort, { once: true });
	return controller.signal;
}
