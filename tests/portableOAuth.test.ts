import { expect, test } from "vitest";
import {
	portableAnthropicOAuth,
	portableCodexOAuth,
	portableGitHubCopilotOAuth,
	portableKimiOAuth,
	portableOpenRouterOAuth,
	portableXaiOAuth,
} from "../src/providers/portableOAuth.ts";
import { PortableCredentialStore } from "../src/platform/credentials.ts";
import { PROVIDERS, ProviderRegistry } from "../src/providers/providerRegistry.ts";

test("xAI refresh keeps a non-rotated refresh token", async () => {
	const restore = stubFetch({ access_token: "next-access", expires_in: 3600 });
	try {
		const credential = await portableXaiOAuth.refresh({
			type: "oauth",
			access: "old-access",
			refresh: "stable-refresh",
			expires: 0,
		});
		expect(credential.access).toBe("next-access");
		expect(credential.refresh).toBe("stable-refresh");
		expect(await portableXaiOAuth.toAuth(credential)).toEqual({ apiKey: "next-access" });
	} finally {
		restore();
	}
});

test("Codex refresh extracts the ChatGPT account claim", async () => {
	const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } });
	const requests: string[] = [];
	const restore = stubFetch([
		{ access_token: access, refresh_token: "next-refresh", expires_in: 1800 },
		{ models: [
			{ slug: "gpt-5.6-terra", visibility: "list" },
			{ slug: "codex-internal", visibility: "hide" },
		] },
	], requests);
	try {
		const credential = await portableCodexOAuth.refresh({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
		});
		expect(credential.accountId).toBe("account-123");
		expect(credential.refresh).toBe("next-refresh");
		expect(credential.availableModelIds).toEqual(["gpt-5.6-terra"]);
		expect(requests[1]).toContain("chatgpt.com/backend-api/codex/models?client_version=");
		expect(await portableCodexOAuth.toAuth(credential)).toEqual({ apiKey: access });
	} finally {
		restore();
	}
});

test("Codex refresh keeps a non-rotated refresh token", async () => {
	const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-456" } });
	const restore = stubFetch({ access_token: access, expires_in: 1800 });
	try {
		const credential = await portableCodexOAuth.refresh({
			type: "oauth",
			access: "old-access",
			refresh: "stable-refresh",
			expires: 0,
		});
		expect(credential.refresh).toBe("stable-refresh");
		expect(credential.expires).toBeLessThan(Date.now() + 1800 * 1000);
	} finally {
		restore();
	}
});

test("Anthropic portable login uses the manual callback code flow", async () => {
	const events: unknown[] = [];
	const restore = stubFetch({ access_token: "claude-access", refresh_token: "claude-refresh", expires_in: 3600 });
	try {
		const credential = await portableAnthropicOAuth.login({
			prompt: async (prompt) => {
				expect(prompt.type).toBe("manual_code");
				return "authorization-code";
			},
			notify: (event) => events.push(event),
		});
		expect(events).toEqual([expect.objectContaining({ type: "auth_url", url: expect.stringContaining("claude.ai/oauth/authorize") })]);
		expect(credential).toMatchObject({ type: "oauth", access: "claude-access", refresh: "claude-refresh" });
		expect(await portableAnthropicOAuth.toAuth(credential)).toEqual({ apiKey: "claude-access" });
	} finally {
		restore();
	}
});

test("Kimi subscription refresh derives a bearer header", async () => {
	const restore = stubFetch({ access_token: "kimi-access", refresh_token: "kimi-refresh-2", expires_in: 3600 });
	try {
		const credential = await portableKimiOAuth.refresh({ type: "oauth", access: "old", refresh: "kimi-refresh", expires: 0 });
		expect(credential.refresh).toBe("kimi-refresh-2");
		expect(await portableKimiOAuth.toAuth(credential)).toEqual({ headers: { Authorization: "Bearer kimi-access" } });
	} finally {
		restore();
	}
});

test("GitHub Copilot refresh keeps account routing and filters its model catalog", async () => {
	const requests: string[] = [];
	const restore = stubFetch([
		{ token: "tid=1;proxy-ep=proxy.business.githubcopilot.com;", expires_at: Math.floor(Date.now() / 1000) + 3600 },
		{ data: [
			{ id: "gpt-5", model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { supports: { tool_calls: true } } },
			{ id: "disabled", model_picker_enabled: true, policy: { state: "disabled" }, capabilities: { supports: { tool_calls: true } } },
		] },
	], requests);
	try {
		const credential = await portableGitHubCopilotOAuth.refresh({
			type: "oauth",
			access: "old",
			refresh: "github-access",
			expires: 0,
		});
		expect(credential.availableModelIds).toEqual(["gpt-5"]);
		expect(await portableGitHubCopilotOAuth.toAuth(credential)).toEqual({
			apiKey: "tid=1;proxy-ep=proxy.business.githubcopilot.com;",
			baseUrl: "https://api.business.githubcopilot.com",
		});
		expect(requests).toEqual([
			"https://api.github.com/copilot_internal/v2/token",
			"https://api.business.githubcopilot.com/models",
		]);
	} finally {
		restore();
	}
});

test("OpenRouter OAuth credentials remain permanent API keys", async () => {
	const credential = { type: "oauth" as const, access: "sk-or-oauth", refresh: "", expires: Number.MAX_SAFE_INTEGER };
	expect(await portableOpenRouterOAuth.refresh(credential)).toBe(credential);
	expect(await portableOpenRouterOAuth.toAuth(credential)).toEqual({ apiKey: "sk-or-oauth" });
});

test("advertises every portable subscription sign-in", () => {
	const labels = Object.fromEntries(PROVIDERS.filter((provider) => provider.subscriptionLabel).map((provider) => [provider.id, provider.subscriptionLabel]));
	expect(labels).toMatchObject({
		anthropic: "Connect Claude Pro / Max",
		"github-copilot": "Connect GitHub Copilot",
		"kimi-coding": "Connect Kimi Code",
		"openai-codex": "Sign in with ChatGPT",
		xai: "Connect Grok / X subscription",
	});
});

test("filters pi's complete Copilot catalog to models available for the signed-in account", async () => {
	const credentials = new PortableCredentialStore(null);
	await credentials.modify("github-copilot", async () => ({
		type: "oauth",
		access: "access",
		refresh: "refresh",
		expires: Date.now() + 60_000,
		availableModelIds: ["gpt-5-mini"],
	}));
	const registry = new ProviderRegistry(credentials);
	expect(registry.getModels("github-copilot").length).toBeGreaterThan(10);
	const modelIds = (await registry.refreshModelAvailability("github-copilot")).map((model) => model.id);
	expect(modelIds).toEqual(["gpt-5-mini"]);
	expect(registry.resolveModel("github-copilot", "gpt-4.1").id).toBe("gpt-5-mini");
	expect(await credentials.list()).toContainEqual({ providerId: "github-copilot", type: "oauth" });
});

test("filters Codex models to the signed-in ChatGPT account catalog", async () => {
	const credentials = new PortableCredentialStore(null);
	await credentials.modify("openai-codex", async () => ({
		type: "oauth",
		access: "access",
		refresh: "refresh",
		expires: Date.now() + 60_000,
		accountId: "account-123",
		availableModelIds: ["gpt-5.6-terra"],
	}));
	const registry = new ProviderRegistry(credentials);
	const models = await registry.refreshModelAvailability("openai-codex");
	expect(models.map((model) => model.id)).toEqual(["gpt-5.6-terra"]);
});

function stubFetch(body: Record<string, unknown> | Array<Record<string, unknown>>, requests?: string[]): () => void {
	const previous = globalThis.fetch;
	const bodies = Array.isArray(body) ? [...body] : [body];
	globalThis.fetch = async (input) => {
		requests?.push(input instanceof Request ? input.url : String(input));
		const next = bodies.shift();
		if (!next) throw new Error("Unexpected fetch");
		return new Response(JSON.stringify(next), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	return () => { globalThis.fetch = previous; };
}

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.`;
}
