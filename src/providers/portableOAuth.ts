import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

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
const CODEX_TIMEOUT_SECONDS = 15 * 60;
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

type Json = Record<string, unknown>;

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
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
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
	name: "OpenAI (ChatGPT Plus/Pro)",
	loginLabel: "Sign in with ChatGPT Plus/Pro",
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
		return codexCredential(token);
	},
	async refresh(credential, signal) {
		const token = await exchangeCodexToken({
			grant_type: "refresh_token",
			refresh_token: credential.refresh,
			client_id: CODEX_CLIENT_ID,
		}, signal);
		return codexCredential(token);
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};

async function exchangeCodexToken(fields: Record<string, string>, signal?: AbortSignal): Promise<Json> {
	return postForm(CODEX_TOKEN_URL, fields, signal);
}

function codexCredential(body: Json): OAuthCredential {
	const access = requiredString(body, "access_token");
	const payload = decodeJwt(access);
	const auth = payload?.[CODEX_ACCOUNT_CLAIM];
	const accountId = auth && typeof auth === "object" ? optionalString(auth as Json, "chatgpt_account_id") : undefined;
	if (!accountId) throw new Error("Codex token did not include a ChatGPT account ID.");
	return {
		type: "oauth",
		access,
		refresh: requiredString(body, "refresh_token"),
		expires: Date.now() + positiveNumber(body.expires_in, 3600) * 1000,
		accountId,
	};
}

function xaiCredential(body: Json, previousRefresh?: string): OAuthCredential {
	return {
		type: "oauth",
		access: requiredString(body, "access_token"),
		refresh: optionalString(body, "refresh_token") ?? previousRefresh ?? requiredString(body, "refresh_token"),
		expires: Date.now() + positiveNumber(body.expires_in, 3600) * 1000 - 5 * 60 * 1000,
	};
}

async function pollDeviceCode<T extends OAuthCredential | object>(options: {
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

async function requestJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Json }> {
	const response = await fetch(url, init);
	const body = await response.json().catch(() => ({})) as Json;
	return { ok: response.ok, status: response.status, body };
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
