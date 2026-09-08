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

type StreamingSystem = {
  httpStream(
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      followRedirects: boolean;
      signal: AbortSignal;
    },
  ): Promise<Response>;
};

function getStreamingSystem(): StreamingSystem | undefined {
  const system = (globalThis as { system?: Partial<StreamingSystem> }).system;
  return typeof system?.httpStream === "function" ? (system as StreamingSystem) : undefined;
}

type CordovaExec = {
  nativeToJsModes?: { ONLINE_EVENT?: number; EVAL_BRIDGE?: number };
  setNativeToJsBridgeMode?: (mode: number) => void;
};

let orderedCallbacksActive = false;
let previousNativeToJsMode: number | undefined;
let previousFetch: typeof fetch | undefined;

function getCordovaExec(): CordovaExec | undefined {
  return (globalThis as { cordova?: { exec?: CordovaExec } }).cordova?.exec;
}

function selectOrderedNativeCallbacks(): void {
  if (orderedCallbacksActive) return;
  const exec = getCordovaExec();
  const online = exec?.nativeToJsModes?.ONLINE_EVENT;
  if (typeof online !== "number" || typeof exec?.setNativeToJsBridgeMode !== "function") return;
  // EVAL_BRIDGE can deliver native stream chunks out of order on Android.
  previousNativeToJsMode = exec.nativeToJsModes?.EVAL_BRIDGE;
  exec.setNativeToJsBridgeMode(online);
  orderedCallbacksActive = true;
}

function restoreNativeCallbacks(): void {
  if (!orderedCallbacksActive) return;
  orderedCallbacksActive = false;
  const mode = previousNativeToJsMode;
  previousNativeToJsMode = undefined;
  const exec = getCordovaExec();
  if (typeof mode !== "number" || typeof exec?.setNativeToJsBridgeMode !== "function") return;
  exec.setNativeToJsBridgeMode(mode);
}

export function getCordovaHttp(): CordovaHttp | undefined {
  const http = (globalThis as { cordova?: { plugin?: { http?: CordovaHttp } } }).cordova?.plugin
    ?.http;
  return http && typeof http.sendRequest === "function" ? http : undefined;
}

/** Prefer Acode's native response stream, with buffered HTTP for older versions. */
export const nativeFetch: typeof fetch = async (input, init) => {
  const system = getStreamingSystem();
  const http = getCordovaHttp();
  if (!system && !http) {
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
  if (request.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");

  if (system) {
    // httpStream already returns a byte-stream Response; the provider owns SSE parsing.
    return system.httpStream(url, {
      method: request.method,
      headers,
      body: data,
      followRedirects: request.redirect === "follow",
      signal: request.signal,
    });
  }
  if (!http) throw new TypeError("Native HTTP is unavailable");

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
  if (!getStreamingSystem() && !getCordovaHttp()) return false;
  if (getStreamingSystem()) selectOrderedNativeCallbacks();
  if (globalThis.fetch !== nativeFetch) {
    previousFetch = globalThis.fetch;
    globalThis.fetch = nativeFetch;
  }
  return true;
}

export function uninstallNativeFetch(): void {
  restoreNativeCallbacks();
  if (globalThis.fetch === nativeFetch && previousFetch) globalThis.fetch = previousFetch;
  previousFetch = undefined;
}

function toFetchResponse(raw: CordovaHttpResponse): Response {
  const status = clampStatus(raw.status);
  const body = raw.data == null ? (raw.error ?? "") : raw.data;
  const responseBody = NULL_BODY_STATUSES.has(status)
    ? null
    : typeof body === "string"
      ? body
      : JSON.stringify(body);
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw.headers ?? {})) {
    if (typeof value === "string") headers.set(key, value);
  }
  if (
    responseBody !== null &&
    !headers.has("content-type") &&
    typeof body === "string" &&
    looksJson(body)
  ) {
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
