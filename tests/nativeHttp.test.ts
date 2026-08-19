import { expect, test } from "vitest";
import { getCordovaHttp, nativeFetch } from "../src/platform/nativeHttp.ts";

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
		success: (response: { status?: number; data?: unknown; error?: string; headers?: Record<string, string> }) => void,
		failure: (error: { status?: number; data?: unknown; error?: string; headers?: Record<string, string> }) => void,
	) => number;
	abort: (id: number) => void;
}): void {
	(globalThis as { cordova?: { plugin: { http: unknown } } }).cordova = { plugin: { http } };
}
