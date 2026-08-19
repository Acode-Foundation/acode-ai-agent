import { expect, test } from "vitest";
import { htmlToReadable } from "../src/tools/web/extract.ts";
import { formatSearchResponse, parseWebSearchOutput } from "../src/tools/web/format.ts";
import { autoSearchPlan, nativeProviderFor, searchWeb } from "../src/tools/web/router.ts";
import type { WebSearchContext } from "../src/tools/web/types.ts";
import { getWebViewApi, parseScrapedResults, searchWithWebView } from "../src/tools/web/webviewSearch.ts";
import { cleanUrl } from "../src/tools/web/request.ts";
import { assertPublicHttpUrl, isPrivateHost, rewriteGithubBlob } from "../src/tools/web/ssrf.ts";
import { presentTool } from "../src/ui/transcript.ts";

test("auto search uses native search only when the model host has it, then the device WebView", () => {
	expect(nativeProviderFor("openrouter")).toBeUndefined();
	expect(nativeProviderFor("openai-codex")).toBe("openai");
	expect(nativeProviderFor("groq")).toBeUndefined();
	expect(autoSearchPlan("openai")).toEqual(["openai", "webview"]);
	expect(autoSearchPlan("openrouter")).toEqual(["webview"]);
	expect(autoSearchPlan("groq")).toEqual(["webview"]);
});

test("blocks private and local fetch targets", () => {
	for (const url of [
		"http://localhost/secret",
		"http://127.0.0.1/x",
		"http://192.168.1.9/admin",
		"http://10.0.0.5/",
		"http://169.254.169.254/latest/meta-data",
		"file:///etc/passwd",
		"http://metadata.google.internal/",
	]) {
		expect(() => assertPublicHttpUrl(url)).toThrow();
	}
	expect(assertPublicHttpUrl("https://docs.example.com/guide").hostname).toBe("docs.example.com");
	expect(isPrivateHost("172.16.4.1")).toBe(true);
	expect(isPrivateHost("8.8.8.8")).toBe(false);
});

test("rewrites GitHub blob URLs to raw file contents", () => {
	expect(rewriteGithubBlob(new URL("https://github.com/acode/app/blob/main/src/index.ts"))).toBe(
		"https://raw.githubusercontent.com/acode/app/main/src/index.ts",
	);
	expect(rewriteGithubBlob(new URL("https://example.com/blob/main/x"))).toBe("https://example.com/blob/main/x");
});

test("turns HTML into readable text", () => {
	const { title, content } = htmlToReadable(
		`<!doctype html><html><head><title>Install guide</title></head><body><nav>skip</nav><article><h1>Setup</h1><p>Run <code>npm i</code>.</p><a href="https://example.com">docs</a></article></body></html>`,
		"https://example.com/install",
	);
	expect(title).toBe("Install guide");
	expect(content).toContain("# Setup");
	expect(content).toContain("`npm i`");
	expect(content).toContain("[docs](https://example.com)");
});

test("round-trips search formatting for the work log", () => {
	const text = formatSearchResponse({
		provider: "openai",
		answer: "Use the new Widgets API.",
		results: [
			{ title: "Widgets", url: "https://docs.example.com/widgets", snippet: "Create a widget." },
			{ title: "Changelog", url: "https://example.com/changelog", snippet: "" },
		],
	}, "widgets api");
	const parsed = parseWebSearchOutput(text);
	expect(parsed?.provider).toBe("openai");
	expect(parsed?.query).toBe("widgets api");
	expect(parsed?.answer).toContain("Widgets API");
	expect(parsed?.results).toEqual([
		{ title: "Widgets", url: "https://docs.example.com/widgets", snippet: "Create a widget." },
		{ title: "Changelog", url: "https://example.com/changelog", snippet: "" },
	]);
});

test("presents web tools in the work log", () => {
	expect(presentTool("web_search", { query: "zod 4 migrate" }, "Web search via openai · “zod 4 migrate”\n\nSources")).toEqual({
		kind: "web",
		label: "Searched the web",
		detail: "zod 4 migrate · openai",
	});
	expect(presentTool("fetch_content", { url: "https://docs.example.com/x" }).kind).toBe("web");
});

test("falls back from native OpenAI search to the device WebView", async () => {
	const previous = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		calls.push(String(input));
		return new Response("upstream down", { status: 503 });
	};
	const restore = installWebView([{ title: "Docs", url: "https://docs.example/guide", snippet: "Official guide" }]);
	try {
		const response = await searchWeb("official guide", {}, mockContext("openai"));
		expect(response.provider).toBe("webview");
		expect(response.results[0]?.url).toBe("https://docs.example/guide");
		expect(calls.some((url) => url.includes("api.openai.com"))).toBe(true);
	} finally {
		globalThis.fetch = previous;
		restore();
	}
});

test("skips native search when the model provider has none", async () => {
	const previous = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		calls.push(String(input));
		return new Response("missing", { status: 404 });
	};
	const restore = installWebView([{ title: "A", url: "https://a.example", snippet: "hi" }]);
	try {
		const response = await searchWeb("hi", {}, mockContext("groq"));
		expect(response.provider).toBe("webview");
		expect(calls.some((url) => url.includes("api.openai.com") || url.includes("api.x.ai"))).toBe(false);
	} finally {
		globalThis.fetch = previous;
		restore();
	}
});

test("unwraps DDG redirect links and drops search-engine junk", () => {
	expect(cleanUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fapi&utm_source=ddg")).toBe("https://docs.example.com/api");
	expect(cleanUrl("https://www.bing.com/search?q=widgets")).toBe("");
	expect(cleanUrl("https://docs.python.org/3/library/os.html?utm_medium=share")).toBe("https://docs.python.org/3/library/os.html");
});

test("parses device WebView scrape payloads", () => {
	expect(getWebViewApi()).toBeUndefined();
	expect(parseScrapedResults(JSON.stringify([
		{ title: "Docs", url: "https://docs.example/x", snippet: "Guide" },
		{ title: "Skip", url: "not-a-url", snippet: "" },
		{ title: "Engine", url: "https://duckduckgo.com/l/?q=foo", snippet: "" },
	]), { numResults: 5 })).toEqual([
		{ title: "Docs", url: "https://docs.example/x", snippet: "Guide" },
	]);
});

test("searches through a hidden Acode WebView", async () => {
	const listeners = new Map<string, Acode.WebViewEventCallback>();
	const view: Acode.WebViewInstance = {
		id: "wv_test",
		async loadURL(url) {
			listeners.get("pageFinished")?.("pageFinished", { url });
		},
		async loadHTML() {},
		async evaluate() {
			return JSON.stringify([{ title: "Docs", url: "https://docs.example/guide", snippet: "Official guide" }]);
		},
		async postMessage() {},
		onMessage() {},
		offMessage() {},
		on(event, callback) {
			listeners.set(event, callback);
		},
		off(event) {
			listeners.delete(event);
		},
		async show() {},
		async hide() {},
		async reload() {},
		async destroy() {},
	};
	const previous = (globalThis as { acode?: unknown }).acode;
	(globalThis as { acode?: { require: (id: string) => unknown } }).acode = {
		require: (id) => id === "webview" ? { create: async () => view } : undefined,
	};
	try {
		const response = await searchWithWebView("official guide");
		expect(response.provider).toBe("webview");
		expect(response.results[0]).toMatchObject({ title: "Docs", url: "https://docs.example/guide" });
	} finally {
		(globalThis as { acode?: unknown }).acode = previous;
	}
});

test("labels device search results as device", () => {
	const text = formatSearchResponse({
		provider: "webview",
		answer: "",
		results: [{ title: "A", url: "https://a.example", snippet: "" }],
	}, "q");
	expect(text).toContain("Web search via device");
	expect(parseWebSearchOutput(text)?.provider).toBe("device");
});

function mockContext(providerId: string): WebSearchContext {
	return {
		currentProviderId: () => providerId,
		currentModelId: () => "test-model",
		resolveAuth: async () => ({ apiKey: "test-key", modelId: "test-model" }),
	};
}

function installWebView(results: Array<{ title: string; url: string; snippet: string }>): () => void {
	const listeners = new Map<string, Acode.WebViewEventCallback>();
	const view: Acode.WebViewInstance = {
		id: "wv_test",
		async loadURL(url) {
			listeners.get("pageFinished")?.("pageFinished", { url });
		},
		async loadHTML() {},
		async evaluate() {
			return JSON.stringify(results);
		},
		async postMessage() {},
		onMessage() {},
		offMessage() {},
		on(event, callback) {
			listeners.set(event, callback);
		},
		off(event) {
			listeners.delete(event);
		},
		async show() {},
		async hide() {},
		async reload() {},
		async destroy() {},
	};
	const previous = (globalThis as { acode?: unknown }).acode;
	(globalThis as { acode?: { require: (id: string) => unknown } }).acode = {
		require: (id) => id === "webview" ? { create: async () => view } : undefined,
	};
	return () => {
		(globalThis as { acode?: unknown }).acode = previous;
	};
}
