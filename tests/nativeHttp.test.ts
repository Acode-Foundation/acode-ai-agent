import assert from "node:assert/strict";
import test from "node:test";
import { getCordovaHttp, nativeFetch } from "../src/platform/nativeHttp.ts";

test("falls back to global fetch when Cordova HTTP is missing", async () => {
	assert.equal(getCordovaHttp(), undefined);
	const previous = globalThis.fetch;
	globalThis.fetch = async () => new Response("ok", { status: 201 });
	try {
		const response = await nativeFetch("https://example.test/fallback");
		assert.equal(response.status, 201);
		assert.equal(await response.text(), "ok");
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
				failure({ status: 401, error: "denied", data: JSON.stringify({ error: "denied" }), headers: { "content-type": "application/json" } });
			} else {
				success({ status: 200, data: JSON.stringify({ ok: true }), headers: { "content-type": "application/json" } });
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
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { ok: true });
		assert.equal(calls[0]?.options.method, "post");
		assert.equal(calls[0]?.options.serializer, "utf8");
		assert.equal(calls[0]?.options.responseType, "text");

		const denied = await nativeFetch("https://api.example.test/token", {
			method: "POST",
			body: "fail",
		});
		assert.equal(denied.status, 401);
		assert.equal(denied.ok, false);
	} finally {
		delete (globalThis as { cordova?: unknown }).cordova;
	}
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
		await assert.rejects(() => pending, { name: "AbortError" });
		assert.equal(aborted, 1);
	} finally {
		delete (globalThis as { cordova?: unknown }).cordova;
	}
});

function installHttp(http: {
	sendRequest: (
		url: string,
		options: Record<string, unknown>,
		success: (response: { status?: number; data?: unknown; error?: string; headers?: Record<string, string> }) => void,
		failure: (error: { status?: number; data?: unknown; error?: string; headers?: Record<string, string> }) => void,
	) => number;
	abort: (id: number) => void;
}): void {
	(globalThis as { cordova?: { plugin: { http: unknown } } }).cordova = { plugin: { http } };
}
