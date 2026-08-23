type CordovaHttpResponse = {
	status?: number;
	data?: unknown;
	error?: string;
	headers?: Record<string, string>;
	url?: string;
};

type CordovaHttp = {
	sendRequest(
		url: string,
		options: {
			method: string;
			headers?: Record<string, string>;
			data?: unknown;
			serializer?: string;
			responseType?: string;
		},
		success: (response: CordovaHttpResponse) => void,
		failure: (error: CordovaHttpResponse) => void,
	): number;
	abort(requestId: number, success?: () => void, failure?: () => void): void;
};

const originalFetch = globalThis.fetch.bind(globalThis);

export function getCordovaHttp(): CordovaHttp | undefined {
	const http = (globalThis as { cordova?: { plugin?: { http?: CordovaHttp } } }).cordova?.plugin?.http;
	return http && typeof http.sendRequest === "function" ? http : undefined;
}

/** Routes http(s) through Cordova advanced-http so Eruda/WebView CORS never see it. */
export const nativeFetch: typeof fetch = async (input, init) => {
	const http = getCordovaHttp();
	if (!http) {
		const fallback = globalThis.fetch === nativeFetch ? originalFetch : globalThis.fetch;
		return fallback(input, init);
	}

	const request = input instanceof Request && !init ? input : new Request(input, init);
	const url = request.url;
	if (!/^https?:\/\//i.test(url)) return originalFetch(request);

	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const method = request.method.toLowerCase();
	const hasBody = method !== "get" && method !== "head";
	const data = hasBody ? await request.text() : undefined;

	return new Promise((resolve, reject) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		let settled = false;
		let requestId: number | undefined;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = () => {
			if (requestId !== undefined) http.abort(requestId);
			finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));
		};
		if (signal?.aborted) {
			finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));
			return;
		}
		signal?.addEventListener("abort", onAbort);

		requestId = http.sendRequest(
			url,
			{
				method,
				headers,
				data: data || undefined,
				serializer: hasBody ? "utf8" : undefined,
				responseType: "text",
			},
			(response) => finish(() => resolve(toFetchResponse(response))),
			(error) => {
				if (typeof error?.status === "number") {
					finish(() => resolve(toFetchResponse(error)));
					return;
				}
				finish(() => reject(new TypeError(error?.error || "Native HTTP request failed")));
			},
		);
	});
};

export function installNativeFetch(): boolean {
	if (!getCordovaHttp()) return false;
	if (globalThis.fetch === nativeFetch) return true;
	globalThis.fetch = nativeFetch;
	return true;
}

function toFetchResponse(raw: CordovaHttpResponse): Response {
	const status = clampStatus(raw.status);
	const body = raw.data == null ? raw.error ?? "" : raw.data;
	const responseBody = NULL_BODY_STATUSES.has(status)
		? null
		: typeof body === "string" ? body : JSON.stringify(body);
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw.headers ?? {})) {
		if (typeof value === "string") headers.set(key, value);
	}
	if (responseBody !== null && !headers.has("content-type") && typeof body === "string" && looksJson(body)) {
		headers.set("Content-Type", "application/json");
	}
	return new Response(responseBody, {
		status,
		statusText: statusText(status, raw.error),
		headers,
	});
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function clampStatus(status: number | undefined): number {
	if (typeof status === "number" && status >= 200 && status <= 599) return status;
	return 502;
}

function statusText(status: number, error?: string): string {
	if (status >= 200 && status < 300) return "OK";
	return error?.trim() || "Error";
}

function looksJson(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}
