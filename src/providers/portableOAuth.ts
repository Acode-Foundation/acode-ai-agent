import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "http://localhost:53692/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;
const GITHUB_API_VERSION = "2026-06-01";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_AUTH_BASE = "https://auth.kimi.com";

const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_REDIRECT_URI = "http://localhost/oauth/callback";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_BASE = "https://auth.openai.com";
const CODEX_DEVICE_URL = `${CODEX_AUTH_BASE}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE}/api/accounts/deviceauth/token`;
const CODEX_VERIFY_URL = `${CODEX_AUTH_BASE}/codex/device`;
const CODEX_TOKEN_URL = `${CODEX_AUTH_BASE}/oauth/token`;
const CODEX_REDIRECT_URI = `${CODEX_AUTH_BASE}/deviceauth/callback`;
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.83.0";
const CODEX_TIMEOUT_SECONDS = 15 * 60;
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

type Json = Record<string, unknown>;

export const portableAnthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	loginLabel: "Sign in with Claude Pro or Max",
	async login(interaction) {
		const { verifier, challenge } = await generatePkce();
		const authUrl = new URL(ANTHROPIC_AUTHORIZE_URL);
		authUrl.search = new URLSearchParams({
			code: "true",
			client_id: ANTHROPIC_CLIENT_ID,
			response_type: "code",
			redirect_uri: ANTHROPIC_REDIRECT_URI,
			scope: ANTHROPIC_SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		}).toString();
		interaction.notify({
			type: "auth_url",
			url: authUrl.href,
			instructions: "Finish signing in, then paste the final redirect URL or authorization code below.",
		});
		const input = await interaction.prompt({
			type: "manual_code",
			message: "Paste the final redirect URL or authorization code",
			placeholder: `${ANTHROPIC_REDIRECT_URI}?code=…`,
		});
		const parsed = parseAuthorizationInput(input);
		if (!parsed.code) throw new Error("Anthropic sign-in did not return an authorization code.");
		if (parsed.state && parsed.state !== verifier) throw new Error("Anthropic OAuth state mismatch.");
		const token = await postJson(ANTHROPIC_TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: ANTHROPIC_CLIENT_ID,
			code: parsed.code,
			state: parsed.state ?? verifier,
			redirect_uri: ANTHROPIC_REDIRECT_URI,
			code_verifier: verifier,
		}, interaction.signal);
		return standardOAuthCredential(token);
	},
	async refresh(credential, signal) {
		const token = await postJson(ANTHROPIC_TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: ANTHROPIC_CLIENT_ID,
			refresh_token: credential.refresh,
		}, signal);
		return standardOAuthCredential(token, credential.refresh);
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

export const portableGitHubCopilotOAuth: OAuthAuth = {
	name: "GitHub Copilot",
	loginLabel: "Sign in with GitHub Copilot",
	async login(interaction) {
		const input = await interaction.prompt({
			type: "text",
			message: "GitHub Enterprise domain (leave blank for github.com)",
			placeholder: "company.ghe.com",
		});
		const enterpriseDomain = normalizeDomain(input);
		if (input.trim() && !enterpriseDomain) throw new Error("Enter a valid GitHub Enterprise domain.");
		const domain = enterpriseDomain ?? "github.com";
		const urls = githubUrls(domain);
		const device = await postForm(urls.deviceCode, {
			client_id: GITHUB_CLIENT_ID,
			scope: "read:user",
		}, interaction.signal);
		const deviceCode = requiredString(device, "device_code");
		const userCode = requiredString(device, "user_code");
		const verificationUri = secureUrl(requiredString(device, "verification_uri"));
		const interval = positiveNumber(device.interval, 5);
		const expiresIn = positiveNumber(device.expires_in, 900);
		interaction.notify({ type: "device_code", userCode, verificationUri, intervalSeconds: interval, expiresInSeconds: expiresIn });
		const githubAccess = await pollDeviceCode<string>({
			intervalSeconds: interval,
			expiresInSeconds: expiresIn,
			signal: interaction.signal,
			poll: async () => {
				const response = await postFormAllowError(urls.accessToken, {
					client_id: GITHUB_CLIENT_ID,
					device_code: deviceCode,
					grant_type: OAUTH_DEVICE_GRANT,
				}, interaction.signal);
				const access = optionalString(response.body, "access_token");
				if (response.ok && access) return { done: access };
				return pendingResult(response.body);
			},
		});
		return githubCopilotCredential(githubAccess, enterpriseDomain, interaction.signal);
	},
	async refresh(credential, signal) {
		return githubCopilotCredential(credential.refresh, credentialEnterpriseDomain(credential), signal);
	},
	async toAuth(credential) {
		const enterpriseDomain = credentialEnterpriseDomain(credential);
		return { apiKey: credential.access, baseUrl: githubCopilotBaseUrl(credential.access, enterpriseDomain) };
	},
};

export const portableKimiOAuth: OAuthAuth = {
	name: "Kimi Code (subscription)",
	loginLabel: "Sign in with Kimi Code",
	async login(interaction) {
		const device = await postForm(`${KIMI_AUTH_BASE}/api/oauth/device_authorization`, {
			client_id: KIMI_CLIENT_ID,
		}, interaction.signal);
		const deviceCode = requiredString(device, "device_code");
		const userCode = requiredString(device, "user_code");
		const verificationUri = secureUrl(optionalString(device, "verification_uri_complete") ?? requiredString(device, "verification_uri"));
		const interval = positiveNumber(device.interval, 5);
		const expiresIn = positiveNumber(device.expires_in, 900);
		interaction.notify({ type: "device_code", userCode, verificationUri, intervalSeconds: interval, expiresInSeconds: expiresIn });
		return pollDeviceCode<OAuthCredential>({
			intervalSeconds: interval,
			expiresInSeconds: expiresIn,
			signal: interaction.signal,
			poll: async () => {
				const response = await postFormAllowError(`${KIMI_AUTH_BASE}/api/oauth/token`, {
					client_id: KIMI_CLIENT_ID,
					device_code: deviceCode,
					grant_type: OAUTH_DEVICE_GRANT,
				}, interaction.signal);
				if (response.ok && optionalString(response.body, "access_token")) return { done: standardOAuthCredential(response.body, undefined, false) };
				return pendingResult(response.body);
			},
		});
	},
	async refresh(credential, signal) {
		const token = await postForm(`${KIMI_AUTH_BASE}/api/oauth/token`, {
			client_id: KIMI_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credential.refresh,
		}, signal);
		return standardOAuthCredential(token, credential.refresh, false);
	},
	async toAuth(credential) {
		return { headers: { Authorization: `Bearer ${credential.access}` } };
	},
};

export const portableOpenRouterOAuth: OAuthAuth = {
	name: "OpenRouter OAuth",
	loginLabel: "Sign in with OpenRouter",
	async login(interaction) {
		const { verifier, challenge } = await generatePkce();
		const authUrl = new URL(OPENROUTER_AUTHORIZE_URL);
		authUrl.search = new URLSearchParams({
			callback_url: OPENROUTER_REDIRECT_URI,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		interaction.notify({
			type: "auth_url",
			url: authUrl.href,
			instructions: "Approve access, then paste the final redirect URL or authorization code below.",
		});
		const input = await interaction.prompt({
			type: "manual_code",
			message: "Paste the final redirect URL or authorization code",
			placeholder: `${OPENROUTER_REDIRECT_URI}?code=…`,
		});
		const code = parseAuthorizationInput(input).code;
		if (!code) throw new Error("OpenRouter sign-in did not return an authorization code.");
		const token = await postJson(OPENROUTER_TOKEN_URL, {
			code,
			code_verifier: verifier,
			code_challenge_method: "S256",
		}, interaction.signal);
		return {
			type: "oauth",
			access: requiredString(token, "key"),
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		};
	},
	async refresh(credential) {
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

export const portableXaiOAuth: OAuthAuth = {
	name: "xAI (Grok/X subscription)",
	loginLabel: "Sign in with SuperGrok or X Premium",
	async login(interaction) {
		const response = await postForm(XAI_DEVICE_URL, {
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
			referrer: "pi",
		}, interaction.signal);
		const deviceCode = requiredString(response, "device_code");
		const userCode = requiredString(response, "user_code");
		const verificationUri = secureUrl(
			optionalString(response, "verification_uri_complete") ?? requiredString(response, "verification_uri"),
		);
		const interval = positiveNumber(response.interval, 5);
		const expiresIn = positiveNumber(response.expires_in, 900);
		interaction.notify({ type: "device_code", userCode, verificationUri, intervalSeconds: interval, expiresInSeconds: expiresIn });
		return pollDeviceCode({
			intervalSeconds: interval,
			expiresInSeconds: expiresIn,
			signal: interaction.signal,
			poll: async () => {
				const token = await postFormAllowError(XAI_TOKEN_URL, {
					grant_type: OAUTH_DEVICE_GRANT,
					client_id: XAI_CLIENT_ID,
					device_code: deviceCode,
				}, interaction.signal);
				if (token.ok) return { done: xaiCredential(token.body) };
				return pendingResult(token.body);
			},
		});
	},
	async refresh(credential, signal) {
		const token = await postForm(XAI_TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: credential.refresh,
		}, signal);
		return xaiCredential(token, credential.refresh);
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

export const portableCodexOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT subscription)",
	loginLabel: "Sign in with ChatGPT",
	async login(interaction) {
		const device = await postJson(CODEX_DEVICE_URL, { client_id: CODEX_CLIENT_ID }, interaction.signal);
		const deviceAuthId = requiredString(device, "device_auth_id");
		const userCode = requiredString(device, "user_code");
		const interval = positiveNumber(device.interval, 5);
		interaction.notify({
			type: "device_code",
			userCode,
			verificationUri: CODEX_VERIFY_URL,
			intervalSeconds: interval,
			expiresInSeconds: CODEX_TIMEOUT_SECONDS,
		});
		const code = await pollDeviceCode<{ authorizationCode: string; codeVerifier: string }>({
			intervalSeconds: interval,
			expiresInSeconds: CODEX_TIMEOUT_SECONDS,
			signal: interaction.signal,
			poll: async () => {
				const response = await postJsonAllowError(CODEX_DEVICE_TOKEN_URL, {
					device_auth_id: deviceAuthId,
					user_code: userCode,
				}, interaction.signal);
				if (response.ok) {
					return { done: {
						authorizationCode: requiredString(response.body, "authorization_code"),
						codeVerifier: requiredString(response.body, "code_verifier"),
					} };
				}
				const error = typeof response.body.error === "object"
					? optionalString(response.body.error as Json, "code")
					: optionalString(response.body, "error");
				if (response.status === 403 || response.status === 404 || error === "deviceauth_authorization_pending") return { pending: true };
				if (error === "slow_down") return { slowDown: true };
				return { error: `Codex device authorization failed (HTTP ${response.status}).` };
			},
		});
		const token = await exchangeCodexToken({
			grant_type: "authorization_code",
			client_id: CODEX_CLIENT_ID,
			code: code.authorizationCode,
			code_verifier: code.codeVerifier,
			redirect_uri: CODEX_REDIRECT_URI,
		}, interaction.signal);
		return codexCredential(token, undefined, interaction.signal);
	},
	async refresh(credential, signal) {
		const token = await exchangeCodexToken({
			grant_type: "refresh_token",
			refresh_token: credential.refresh,
			client_id: CODEX_CLIENT_ID,
		}, signal);
		return codexCredential(token, credential, signal);
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

async function exchangeCodexToken(fields: Record<string, string>, signal?: AbortSignal): Promise<Json> {
	return postForm(CODEX_TOKEN_URL, fields, signal);
}

async function codexCredential(body: Json, previous?: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
	const access = requiredString(body, "access_token");
	const payload = decodeJwt(access);
	const auth = payload?.[CODEX_ACCOUNT_CLAIM];
	const accountId = auth && typeof auth === "object" ? optionalString(auth as Json, "chatgpt_account_id") : undefined;
	if (!accountId) throw new Error("Codex token did not include a ChatGPT account ID.");
	const credential: OAuthCredential = {
		type: "oauth",
		access,
		refresh: optionalString(body, "refresh_token") ?? previous?.refresh ?? requiredString(body, "refresh_token"),
		expires: Date.now() + positiveNumber(body.expires_in, 3600) * 1000 - 60_000,
		accountId,
	};
	try {
		return await refreshPortableCodexModels(credential, signal);
	} catch {
		const previousIds = previous?.availableModelIds;
		return Array.isArray(previousIds) && previousIds.every((id) => typeof id === "string")
			? { ...credential, availableModelIds: previousIds, availableModelsFetchedAt: previous?.availableModelsFetchedAt }
			: credential;
	}
}

/** Resolve the actual picker catalog returned for this ChatGPT account. */
export async function refreshPortableCodexModels(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
	const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
	if (!accountId) throw new Error("Codex credential is missing its ChatGPT account ID.");
	const response = await requestJson(CODEX_MODELS_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${credential.access}`,
			"ChatGPT-Account-Id": accountId,
			originator: "pi",
		},
		signal,
	});
	if (!response.ok) throw new Error(requestError(response.url, response.status, response.body));
	const models = response.body.models;
	if (!Array.isArray(models)) throw new Error("Codex models response is invalid.");
	const availableModelIds = models.flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const model = value as Json;
		return typeof model.slug === "string" && model.visibility === "list" ? [model.slug] : [];
	});
	return { ...credential, availableModelIds, availableModelsFetchedAt: Date.now() };
}

function xaiCredential(body: Json, previousRefresh?: string): OAuthCredential {
	return {
		type: "oauth",
		access: requiredString(body, "access_token"),
		refresh: optionalString(body, "refresh_token") ?? previousRefresh ?? requiredString(body, "refresh_token"),
		expires: Date.now() + positiveNumber(body.expires_in, 3600) * 1000 - 5 * 60 * 1000,
	};
}

function standardOAuthCredential(body: Json, previousRefresh?: string, applySkew = true): OAuthCredential {
	return {
		type: "oauth",
		access: requiredString(body, "access_token"),
		refresh: optionalString(body, "refresh_token") ?? previousRefresh ?? requiredString(body, "refresh_token"),
		expires: Date.now() + positiveNumber(body.expires_in, 3600) * 1000 - (applySkew ? REFRESH_SKEW_MS : 0),
	};
}

async function githubCopilotCredential(githubAccess: string, enterpriseDomain?: string, signal?: AbortSignal): Promise<OAuthCredential> {
	const domain = enterpriseDomain ?? "github.com";
	const response = await requestJson(githubUrls(domain).copilotToken, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${githubAccess}`,
			...GITHUB_HEADERS,
		},
		signal,
	});
	if (!response.ok) throw new Error(requestError(response.url, response.status, response.body));
	const access = requiredString(response.body, "token");
	const expiresAt = positiveNumber(response.body.expires_at, 0);
	if (!expiresAt) throw new Error("GitHub Copilot token response is missing expires_at.");
	const availableModelIds = await githubCopilotModelIds(access, enterpriseDomain, signal);
	return {
		type: "oauth",
		access,
		refresh: githubAccess,
		expires: expiresAt * 1000 - REFRESH_SKEW_MS,
		enterpriseUrl: enterpriseDomain,
		availableModelIds,
	};
}

async function githubCopilotModelIds(access: string, enterpriseDomain?: string, signal?: AbortSignal): Promise<string[]> {
	const baseUrl = githubCopilotBaseUrl(access, enterpriseDomain);
	const response = await requestJson(`${baseUrl}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${access}`,
			...GITHUB_HEADERS,
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
		},
		signal,
	});
	if (!response.ok) throw new Error(requestError(response.url, response.status, response.body));
	const data = response.body.data;
	if (!Array.isArray(data)) throw new Error("GitHub Copilot models response is invalid.");
	return data.flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const model = value as Json;
		const policy = model.policy && typeof model.policy === "object" ? model.policy as Json : undefined;
		const capabilities = model.capabilities && typeof model.capabilities === "object" ? model.capabilities as Json : undefined;
		const supports = capabilities?.supports && typeof capabilities.supports === "object" ? capabilities.supports as Json : undefined;
		return typeof model.id === "string" && model.model_picker_enabled === true && policy?.state !== "disabled" && supports?.tool_calls !== false
			? [model.id]
			: [];
	});
}

function githubUrls(domain: string) {
	return {
		deviceCode: `https://${domain}/login/device/code`,
		accessToken: `https://${domain}/login/oauth/access_token`,
		copilotToken: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

function githubCopilotBaseUrl(access: string, enterpriseDomain?: string): string {
	const proxyHost = /(?:^|;)proxy-ep=([^;]+)/.exec(access)?.[1];
	if (proxyHost && /^[a-z0-9.-]+$/i.test(proxyHost)) return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
	return enterpriseDomain ? `https://copilot-api.${enterpriseDomain}` : "https://api.individual.githubcopilot.com";
}

function credentialEnterpriseDomain(credential: OAuthCredential): string | undefined {
	return typeof credential.enterpriseUrl === "string" ? normalizeDomain(credential.enterpriseUrl) ?? undefined : undefined;
}

function normalizeDomain(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
		return url.hostname || undefined;
	} catch {
		return undefined;
	}
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = base64Url(bytes);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// Accept a copied query string, code#state pair, or the raw authorization code.
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code: code || undefined, state: state || undefined };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^\?/, ""));
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

async function pollDeviceCode<T>(options: {
	intervalSeconds: number;
	expiresInSeconds: number;
	signal?: AbortSignal;
	poll: () => Promise<{ done?: T; pending?: boolean; slowDown?: boolean; error?: string }>;
}): Promise<T> {
	const deadline = Date.now() + options.expiresInSeconds * 1000;
	let interval = Math.max(1, options.intervalSeconds) * 1000;
	while (Date.now() < deadline) {
		await wait(interval, options.signal);
		const result = await options.poll();
		if (result.done) return result.done;
		if (result.error) throw new Error(result.error);
		if (result.slowDown) interval += 5000;
	}
	throw new Error("Device authorization expired. Start sign-in again.");
}

function pendingResult(body: Json): { pending?: boolean; slowDown?: boolean; error?: string } {
	const error = optionalString(body, "error");
	if (error === "authorization_pending") return { pending: true };
	if (error === "slow_down") return { slowDown: true };
	if (error === "access_denied" || error === "authorization_denied") return { error: "Device authorization was denied." };
	if (error === "expired_token") return { error: "Device authorization expired." };
	return { error: optionalString(body, "error_description") ?? `Device authorization failed${error ? `: ${error}` : "."}` };
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Json> {
	const response = await postFormAllowError(url, fields, signal);
	if (!response.ok) throw new Error(requestError(url, response.status, response.body));
	return response.body;
}

async function postFormAllowError(url: string, fields: Record<string, string>, signal?: AbortSignal) {
	return requestJson(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), signal });
}

async function postJson(url: string, body: Json, signal?: AbortSignal): Promise<Json> {
	const response = await postJsonAllowError(url, body, signal);
	if (!response.ok) throw new Error(requestError(url, response.status, response.body));
	return response.body;
}

async function postJsonAllowError(url: string, body: Json, signal?: AbortSignal) {
	return requestJson(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

async function requestJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Json; url: string }> {
	const response = await fetch(url, init);
	const body = await response.json().catch(() => ({})) as Json;
	return { ok: response.ok, status: response.status, body, url };
}

function requestError(url: string, status: number, body: Json): string {
	return `${new URL(url).hostname} authentication failed (HTTP ${status})${optionalString(body, "error_description") ? `: ${optionalString(body, "error_description")}` : ""}`;
}

function requiredString(body: Json, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value) throw new Error(`Authentication response is missing ${field}.`);
	return value;
}

function optionalString(body: Json, field: string): string | undefined {
	const value = body[field];
	return typeof value === "string" && value ? value : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
	const number = typeof value === "string" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : fallback;
}

function secureUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:") throw new Error("Provider returned an unsafe verification URL.");
	return url.href;
}

function decodeJwt(token: string): Json | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
		return JSON.parse(atob(base64)) as Json;
	} catch {
		return undefined;
	}
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("Sign-in cancelled", "AbortError"));
		const onAbort = () => {
			globalThis.clearTimeout(timer);
			reject(new DOMException("Sign-in cancelled", "AbortError"));
		};
		const timer = globalThis.setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
