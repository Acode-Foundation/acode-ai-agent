import { afterEach, expect, test, vi } from "vitest";
import {
  getCordovaHttp,
  initializeNativeHttp,
  nativeFetch,
  disposeNativeHttp,
} from "../src/platform/nativeHttp.ts";

afterEach(() => {
  disposeNativeHttp();
  vi.unstubAllGlobals();
});

test("selects ordered Cordova callbacks once without replacing host fetch", async () => {
  const setNativeToJsBridgeMode = vi.fn();
  vi.stubGlobal("system", { httpStream: vi.fn(async () => new Response("ok")) });
  vi.stubGlobal("cordova", {
    exec: {
      nativeToJsModes: { ONLINE_EVENT: 2, EVAL_BRIDGE: 3 },
      setNativeToJsBridgeMode,
    },
  });
  initializeNativeHttp();
  initializeNativeHttp();
  expect(setNativeToJsBridgeMode).toHaveBeenCalledOnce();
  expect(setNativeToJsBridgeMode).toHaveBeenCalledWith(2);
  await nativeFetch("https://api.example.test/chat");
  expect(setNativeToJsBridgeMode).toHaveBeenCalledOnce();
});

test("restores EVAL_BRIDGE when disposing native HTTP", () => {
  const setNativeToJsBridgeMode = vi.fn();
  const previousFetch = globalThis.fetch;
  vi.stubGlobal("system", { httpStream: vi.fn() });
  vi.stubGlobal("cordova", {
    exec: {
      nativeToJsModes: { ONLINE_EVENT: 2, EVAL_BRIDGE: 3 },
      setNativeToJsBridgeMode,
    },
  });
  initializeNativeHttp();
  disposeNativeHttp();
  expect(setNativeToJsBridgeMode.mock.calls.map((call) => call[0])).toEqual([2, 3]);
  expect(globalThis.fetch).toBe(previousFetch);
});

test("does not change the Cordova bridge when only buffered HTTP is available", () => {
  const setNativeToJsBridgeMode = vi.fn();
  vi.stubGlobal("cordova", {
    exec: {
      nativeToJsModes: { ONLINE_EVENT: 2, EVAL_BRIDGE: 3 },
      setNativeToJsBridgeMode,
    },
    plugin: { http: { sendRequest: vi.fn(), abort: vi.fn() } },
  });
  initializeNativeHttp();
  disposeNativeHttp();
  expect(setNativeToJsBridgeMode).not.toHaveBeenCalled();
});

test("prefers httpStream and delivers bytes before the response finishes", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel,
  });
  const nativeResponse = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const chunk = new TextEncoder().encode('data: {"text":"hello"}\n\n');
  streamController.enqueue(chunk);
  const httpStream = vi.fn(async () => nativeResponse);
  const sendRequest = vi.fn();
  vi.stubGlobal("system", { httpStream });
  vi.stubGlobal("cordova", { plugin: { http: { sendRequest } } });
  const controller = new AbortController();
  const request = new Request("https://api.example.test/chat", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true }),
    signal: controller.signal,
  });
  const response = await nativeFetch(request);
  expect(response).toBe(nativeResponse);
  expect(sendRequest).not.toHaveBeenCalled();
  expect(httpStream).toHaveBeenCalledWith(request.url, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: '{"stream":true}',
    followRedirects: true,
    signal: request.signal,
  });
  const reader = response.body!.getReader();
  expect(await reader.read()).toEqual({ done: false, value: chunk });
  controller.abort();
  expect(request.signal.aborted).toBe(true);
  await reader.cancel();
  expect(cancel).toHaveBeenCalledOnce();
});

test.each(["stream", "buffered"])(
  "%s setup and disposal leave global fetch untouched",
  async (transport) => {
    const hostFetch = vi.fn(async () => new Response("account"));
    const httpStream = vi.fn(async () => new Response("provider"));
    const sendRequest = vi.fn((_url, _options, success) => {
      success({ status: 200, data: "provider" });
      return 1;
    });
    vi.stubGlobal("fetch", hostFetch);
    vi.stubGlobal("system", transport === "stream" ? { httpStream } : undefined);
    vi.stubGlobal("cordova", { plugin: { http: { sendRequest, abort: vi.fn() } } });
    initializeNativeHttp();
    expect(globalThis.fetch).toBe(hostFetch);
    const options: RequestInit = { credentials: "include", cache: "no-store" };
    expect(await (await fetch("https://dev.acode.app/api/login", options)).text()).toBe("account");
    expect(hostFetch).toHaveBeenCalledWith("https://dev.acode.app/api/login", options);
    expect(await (await nativeFetch("https://api.example.test/chat")).text()).toBe("provider");
    expect(transport === "stream" ? httpStream : sendRequest).toHaveBeenCalledOnce();
    disposeNativeHttp();
    expect(globalThis.fetch).toBe(hostFetch);
  },
);

test("preserves native HTTP errors and never retries a failed stream", async () => {
  const denied = new Response('{"error":"denied"}', { status: 401 });
  const httpStream = vi
    .fn()
    .mockResolvedValueOnce(denied)
    .mockRejectedValueOnce(new TypeError("connection lost"));
  const sendRequest = vi.fn();
  vi.stubGlobal("system", { httpStream });
  vi.stubGlobal("cordova", { plugin: { http: { sendRequest } } });
  expect(await nativeFetch("https://api.example.test/chat")).toBe(denied);
  await expect(nativeFetch("https://api.example.test/chat")).rejects.toThrow("connection lost");
  expect(sendRequest).not.toHaveBeenCalled();
});

test("does not start a stream when already aborted", async () => {
  const httpStream = vi.fn();
  vi.stubGlobal("system", { httpStream });
  const controller = new AbortController();
  controller.abort();
  await expect(
    nativeFetch("https://api.example.test/chat", { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(httpStream).not.toHaveBeenCalled();
});

test("uses browser fetch for non-HTTP URLs even when streaming is available", async () => {
  const httpStream = vi.fn();
  vi.stubGlobal("system", { httpStream });
  expect(await (await nativeFetch("data:text/plain,hello")).text()).toBe("hello");
  expect(httpStream).not.toHaveBeenCalled();
});

test("falls back to global fetch when Cordova HTTP is missing", async () => {
  expect(getCordovaHttp()).toBeUndefined();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 201 });
  try {
    const response = await nativeFetch("https://example.test/fallback");
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
  } finally {
    globalThis.fetch = previous;
  }
});

test("sends through cordova.plugin.http and maps error statuses to Response", async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  installHttp({
    sendRequest(url, options, success, failure) {
      calls.push({ url, options });
      if (String(options.data).includes("fail")) {
        failure({
          status: 401,
          error: "denied",
          data: JSON.stringify({ error: "denied" }),
          headers: { "content-type": "application/json" },
        });
      } else {
        success({
          status: 200,
          data: JSON.stringify({ ok: true }),
          headers: { "content-type": "application/json" },
        });
      }
      return 1;
    },
    abort() {},
  });
  try {
    const ok = await nativeFetch("https://api.example.test/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls[0]?.options.method).toBe("post");
    expect(calls[0]?.options.serializer).toBe("utf8");
    expect(calls[0]?.options.responseType).toBe("text");

    const denied = await nativeFetch("https://api.example.test/token", {
      method: "POST",
      body: "fail",
    });
    expect(denied.status).toBe(401);
    expect(denied.ok).toBe(false);
  } finally {
    delete (globalThis as { cordova?: unknown }).cordova;
  }
});

test("drops native payloads for Fetch statuses that forbid a response body", async () => {
  installHttp({
    sendRequest(url, _options, success) {
      const status = Number(new URL(url).pathname.slice(1));
      success({ status, data: "native helper payload", headers: { "content-type": "text/plain" } });
      return status;
    },
    abort() {},
  });
  try {
    for (const status of [204, 205, 304]) {
      const response = await nativeFetch(`https://api.example.test/${status}`);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  } finally {
    delete (globalThis as { cordova?: unknown }).cordova;
  }
});

test("rejects Cordova transport errors instead of inventing an HTTP 502 response", async () => {
  installHttp({
    sendRequest(_url, _options, _success, failure) {
      failure({ status: -3, error: "Host could not be resolved: auth.openai.com" });
      return 1;
    },
    abort() {},
  });
  await expect(nativeFetch("https://auth.openai.com/oauth/token")).rejects.toThrow(
    "Host could not be resolved: auth.openai.com",
  );
});

test("aborts the native request when the signal fires", async () => {
  let aborted = 0;
  installHttp({
    sendRequest(_url, _options, _success, _failure) {
      return 7;
    },
    abort(id) {
      if (id === 7) aborted += 1;
    },
  });
  const controller = new AbortController();
  const pending = nativeFetch("https://api.example.test/slow", { signal: controller.signal });
  controller.abort();
  try {
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(1);
  } finally {
    delete (globalThis as { cordova?: unknown }).cordova;
  }
});

function installHttp(http: {
  sendRequest: (
    url: string,
    options: Record<string, unknown>,
    success: (response: {
      status?: number;
      data?: unknown;
      error?: string;
      headers?: Record<string, string>;
    }) => void,
    failure: (error: {
      status?: number;
      data?: unknown;
      error?: string;
      headers?: Record<string, string>;
    }) => void,
  ) => number;
  abort: (id: number) => void;
}): void {
  (globalThis as { cordova?: { plugin: { http: unknown } } }).cordova = { plugin: { http } };
}

test("leaves the WebView's own origin to the WebView", async () => {
  const httpStream = vi.fn(async () => new Response("native"));
  vi.stubGlobal("system", { httpStream });
  vi.stubGlobal("location", { origin: "https://localhost" });
  // The WebView answers its own origin without a server; here nothing listens, so it fails fast.
  await nativeFetch("https://localhost/__cdvfile_files-external__/plugins/x/asset.wasm").catch(
    () => undefined,
  );
  expect(httpStream).not.toHaveBeenCalled();
  await nativeFetch("https://api.example.test/chat");
  expect(httpStream).toHaveBeenCalledOnce();
});
