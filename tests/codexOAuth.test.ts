import { afterEach, expect, test, vi } from "vitest";
import { portableCodexOAuth } from "../src/providers/portableOAuth.ts";

const callbackUri = "http://localhost:1455/auth/callback";
afterEach(() => vi.unstubAllGlobals());

test("Codex browser login exchanges a state-validated callback with matching PKCE", async () => {
	let authorize: URL;
	const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
	const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
		if (input.includes("/codex/models?")) return Response.json({ models: [{ slug: "gpt-5.6-terra", visibility: "list" }] });
		expect(input).toBe("https://auth.openai.com/oauth/token");
		const fields = new URLSearchParams(String(init?.body));
		expect(fields.get("redirect_uri")).toBe(callbackUri);
		expect(fields.get("client_id")).toBe(authorize.searchParams.get("client_id"));
		expect(fields.get("grant_type")).toBe("authorization_code");
		expect(fields.get("code")).toBe("test-code");
		const verifier = fields.get("code_verifier")!;
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		expect(Buffer.from(digest).toString("base64url")).toBe(authorize.searchParams.get("code_challenge"));
		return Response.json({ access_token: access, refresh_token: "refresh", expires_in: 3600 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const credential = await portableCodexOAuth.login({
		notify(event) {
			expect(event.type).toBe("auth_url");
			if (event.type !== "auth_url") throw new Error("Expected browser login");
			authorize = new URL(event.url);
			expect(authorize.origin + authorize.pathname).toBe("https://auth.openai.com/oauth/authorize");
			expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
				response_type: "code", redirect_uri: callbackUri,
				scope: "openid profile email offline_access", code_challenge_method: "S256",
				id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "pi",
			});
		},
		async prompt(prompt) {
			if (prompt.type === "select") return "browser";
			expect(prompt.type).toBe("manual_code");
			return ` ${callbackUri}?code=test-code&state=${authorize.searchParams.get("state")} `;
		},
	});
	expect(credential).toMatchObject({ access, refresh: "refresh", accountId: "account-123", availableModelIds: ["gpt-5.6-terra"] });
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each(["wrong-state", "missing-state", "missing-code", "denied", "wrong-url", "raw-code"])("Codex rejects %s before exchanging tokens", async (scenario) => {
	let state = "";
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	await expect(portableCodexOAuth.login({
		notify(event) { if (event.type === "auth_url") state = new URL(event.url).searchParams.get("state")!; },
		async prompt(prompt) {
			if (prompt.type === "select") return "browser";
			const callback = new URL(callbackUri);
			callback.searchParams.set("state", state);
			callback.searchParams.set("code", "code");
			if (scenario === "wrong-state") callback.searchParams.set("state", "stale-login");
			if (scenario === "missing-state") callback.searchParams.delete("state");
			if (scenario === "missing-code") callback.searchParams.delete("code");
			if (scenario === "denied") callback.searchParams.set("error", "access_denied");
			if (scenario === "wrong-url") callback.hostname = "example.com";
			return scenario === "raw-code" ? "code" : callback.href;
		},
	})).rejects.toThrow();
	expect(fetchMock).not.toHaveBeenCalled();
});

test("Codex cancellation prevents exchanging a pasted code", async () => {
	const abort = new AbortController();
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	await expect(portableCodexOAuth.login({
		signal: abort.signal,
		notify() {},
		async prompt() { abort.abort(); return callbackUri; },
	})).rejects.toMatchObject({ name: "AbortError" });
	expect(fetchMock).not.toHaveBeenCalled();
});

test("device sign-in completes after approval without a pasted callback", async () => {
	vi.useFakeTimers();
	const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
	const events: string[] = [];
	const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
		if (input.endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD-EFGH", interval: 1 });
		if (input.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "approved-code", code_verifier: "device-verifier" });
		if (input.endsWith("/oauth/token")) {
			const fields = new URLSearchParams(String(init?.body));
			expect(fields.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
			expect(fields.get("code_verifier")).toBe("device-verifier");
			return Response.json({ access_token: access, refresh_token: "refresh", expires_in: 3600 });
		}
		return Response.json({ models: [{ slug: "available-model", visibility: "list" }] });
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const login = portableCodexOAuth.login({
			async prompt(prompt) { expect(prompt.type).toBe("select"); return "device"; },
			notify(event) { events.push(event.type); },
		});
		await vi.runAllTimersAsync();
		expect((await login).accountId).toBe("account");
		expect(events).toEqual(["device_code"]);
	} finally { vi.useRealTimers(); }
});

test("device denial fails promptly instead of polling for fifteen minutes", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/usercode")
		? Response.json({ device_auth_id: "device", user_code: "code", interval: 1 })
		: Response.json({ error: "access_denied" }, { status: 403 })));
	try {
		const login = portableCodexOAuth.login({ async prompt() { return "device"; }, notify() {} });
		const result = expect(login).rejects.toThrow(/Settings → Security/);
		await vi.runAllTimersAsync();
		await result;
	} finally { vi.useRealTimers(); }
});
