import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { PortableCredentialStore } from "../platform/credentials";
import { startLoopbackOAuth } from "../platform/loopbackOAuth";
import { oauthRequest } from "../platform/oauthRequest";
import { verifyChatGPTIdentity, type ChatGPTIdentity } from "./chatgptIdentity";
import { sanitizeModelId } from "./customModels";

export const CHATGPT_PROVIDER = "chatgpt";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const AUTH_BASE = "https://auth.openai.com";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
// The local sign-out is already done; bound how long the UI waits on remote revocation.
const REVOKE_TIMEOUT_MS = 15_000;
type Json = Record<string, unknown>;
export type ChatGPTRegistration = { clientId: string; identity?: ChatGPTIdentity };
type ChatGPTState = { hostId: string; registration?: ChatGPTRegistration };

/** Registrations survive disconnect; rotating tokens remain in the host's protected secret store. */
export class ChatGPTAccount {
  #requests = new Set<AbortController>();
  #disconnects = 0;
  constructor(readonly credentials: PortableCredentialStore) {}

  request(signal?: AbortSignal): { signal: AbortSignal; release(): void } {
    const abort = new AbortController();
    const cancel = () => abort.abort(signal?.reason);
    if (this.#disconnects) abort.abort(new DOMException("ChatGPT was disconnected.", "AbortError"));
    else if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    this.#requests.add(abort);
    return {
      signal: abort.signal,
      release: () => {
        signal?.removeEventListener("abort", cancel);
        this.#requests.delete(abort);
      },
    };
  }

  async state(): Promise<ChatGPTState> {
    const state = await this.credentials.oauthState<ChatGPTState>(CHATGPT_PROVIDER);
    if (state && !("registrations" in state)) return state;
    const active = await this.credentials.read(CHATGPT_PROVIDER);
    const registration =
      active?.type === "oauth" && typeof active.clientId === "string"
        ? { clientId: active.clientId, identity: active.identity as ChatGPTIdentity | undefined }
        : undefined;
    return this.credentials.updateOAuthState<ChatGPTState>(CHATGPT_PROVIDER, (existing) =>
      existing && !("registrations" in existing)
        ? existing
        : {
            hostId: existing?.hostId ?? state?.hostId ?? `urn:uuid:${crypto.randomUUID()}`,
            registration,
          },
    );
  }

  async save(clientId: string, identity?: ChatGPTIdentity): Promise<void> {
    await this.state();
    await this.credentials.updateOAuthState<ChatGPTState>(CHATGPT_PROVIDER, (state) => ({
      hostId: state!.hostId,
      registration: {
        clientId,
        identity:
          identity ??
          (state!.registration?.clientId === clientId ? state!.registration.identity : undefined),
      },
    }));
  }

  async forget(): Promise<void> {
    await this.credentials.modify(CHATGPT_PROVIDER, async (current) => {
      if (current) throw new Error("Disconnect ChatGPT before removing the account.");
      await this.state();
      await this.credentials.updateOAuthState<ChatGPTState>(CHATGPT_PROVIDER, (state) => ({
        hostId: state!.hostId,
      }));
      return undefined;
    });
  }

  async disconnect(): Promise<boolean> {
    this.#disconnects++;
    for (const request of this.#requests)
      request.abort(new DOMException("ChatGPT was disconnected.", "AbortError"));
    this.#requests.clear();
    try {
      let removed = undefined as OAuthCredential | undefined;
      // Serialize against refresh so revocation uses the latest rotating token.
      await this.credentials.delete(CHATGPT_PROVIDER, undefined, async (current) => {
        if (current?.type !== "oauth") return;
        await this.save(String(current.clientId), current.identity as ChatGPTIdentity);
        removed = current;
      });
      // Sign out locally first so a slow or offline revocation cannot keep the session alive.
      return removed ? await revoke(removed) : true;
    } finally {
      this.#disconnects--;
    }
  }
}

export function createChatGPTOAuth(accounts: ChatGPTAccount): OAuthAuth {
  return {
    name: "ChatGPT",
    isSubscription: true,
    loginLabel: "Continue with ChatGPT",
    async login(interaction) {
      interaction.signal.throwIfAborted();
      const state = await accounts.state();
      const registration = state.registration;
      const previous = await accounts.credentials.read(CHATGPT_PROVIDER);
      const verifier = randomValue();
      const challenge = base64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      );
      const oauthState = randomValue();
      const nonce = randomValue();
      const callback = await startLoopbackOAuth(
        oauthState,
        registration?.clientId,
        interaction.signal,
      );
      try {
        const authorization = new URL(`${AUTH_BASE}/api/accounts/authorize`);
        authorization.search = new URLSearchParams({
          client_id: registration?.clientId ?? "dynamic_agent_client",
          ...(registration ? {} : { agent_name_hint: "Acode AI Agent" }),
          ext_agent_host_id: state.hostId,
          response_type: "code",
          redirect_uri: callback.redirectUri,
          scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
          resource: CHATGPT_RESOURCE,
          state: oauthState,
          nonce,
          code_challenge_method: "S256",
          code_challenge: challenge,
          ...(previous?.type === "oauth" &&
          previous.clientId === registration?.clientId &&
          typeof previous.idToken === "string"
            ? { id_token_hint: previous.idToken }
            : {}),
        }).toString();
        interaction.notify({
          type: "auth_url",
          url: callback.browserUrl(authorization.href),
          instructions: "Approve ChatGPT plan access, then tap Return to Acode if needed.",
        });
        const approved = await callback.result;
        // Keep the issued registration even if this one-use code expires or exchange fails.
        await accounts.save(approved.clientId);
        interaction.notify({ type: "progress", message: "Verifying ChatGPT sign-in…" });
        const token = await tokenRequest(
          {
            grant_type: "authorization_code",
            client_id: approved.clientId,
            code: approved.code,
            code_verifier: verifier,
            redirect_uri: callback.redirectUri,
            resource: CHATGPT_RESOURCE,
          },
          interaction.signal,
        );
        const idToken = requiredString(token, "id_token");
        const identity = await verifyChatGPTIdentity(
          idToken,
          approved.clientId,
          nonce,
          interaction.signal,
        );
        if (
          registration?.identity &&
          (registration.identity.subject !== identity.subject ||
            registration.identity.issuer !== identity.issuer)
        )
          throw new Error(
            "ChatGPT returned a different account. Remove the saved account before connecting another.",
          );
        const credential = credentialFromToken(token, approved.clientId, identity, idToken);
        await accounts.save(approved.clientId, identity);
        // Model discovery failure must not discard a valid renewable session.
        try {
          return await refreshChatGPTModels(credential, interaction.signal);
        } catch {
          return credential;
        }
      } finally {
        await callback.close();
      }
    },
    async refresh(credential, signal) {
      const clientId = requiredString(credential, "clientId");
      const token = await tokenRequest(
        {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: credential.refresh,
          resource: CHATGPT_RESOURCE,
        },
        signal,
      );
      // RFC 6749 §6 lets a refresh response omit an unchanged refresh token and scope.
      token.refresh_token ??= credential.refresh;
      if (token.scope === undefined && Array.isArray(credential.scopes))
        token.scope = credential.scopes.join(" ");
      let identity = credential.identity as ChatGPTIdentity;
      let idToken = typeof credential.idToken === "string" ? credential.idToken : undefined;
      if (typeof token.id_token === "string") {
        const refreshedIdentity = await verifyChatGPTIdentity(
          token.id_token,
          clientId,
          undefined,
          signal,
        );
        if (
          !identity ||
          refreshedIdentity.subject !== identity.subject ||
          refreshedIdentity.issuer !== identity.issuer
        )
          throw new Error("ChatGPT refreshed a different account. Sign in again.");
        identity = refreshedIdentity;
        idToken = token.id_token;
      }
      const refreshed = {
        ...credential,
        ...credentialFromToken(token, clientId, identity, idToken),
      };
      return refreshed;
    },
    async toAuth(credential) {
      if (
        !Array.isArray(credential.scopes) ||
        !credential.scopes.includes(PLAN_SCOPE) ||
        !credential.access
      )
        throw new Error(
          "ChatGPT plan usage is not enabled. Continue with ChatGPT to authorize it.",
        );
      return { apiKey: credential.access, baseUrl: CHATGPT_RESOURCE };
    },
  };
}

export async function refreshChatGPTModels(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const response = await oauthRequest(`${CHATGPT_RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${credential.access}`, Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`ChatGPT model discovery failed (HTTP ${response.status}).`);
  const body = response.body as { models?: Json[] };
  if (!Array.isArray(body.models)) throw new Error("ChatGPT returned an invalid model catalog.");
  const availableModels = body.models.flatMap((model) => {
    const id = typeof model.slug === "string" ? sanitizeModelId(model.slug) : undefined;
    return id && model.visibility === "list"
      ? [{ id, name: typeof model.display_name === "string" ? model.display_name : id }]
      : [];
  });
  return { ...credential, availableModels, availableModelsFetchedAt: Date.now() };
}

function credentialFromToken(
  token: Json,
  clientId: string,
  identity: ChatGPTIdentity,
  idToken?: string,
): OAuthCredential {
  const scopes = requiredString(token, "scope").split(/\s+/);
  if (!scopes.includes(PLAN_SCOPE))
    throw new Error("ChatGPT plan usage was not enabled. Sign in again and authorize plan access.");
  const lifetime = token.expires_in;
  if (
    typeof lifetime !== "number" ||
    !Number.isFinite(lifetime) ||
    lifetime <= 0 ||
    token.token_type?.toString().toLowerCase() !== "bearer"
  )
    throw new Error("ChatGPT returned an invalid token lifetime or type.");
  return {
    type: "oauth",
    access: requiredString(token, "access_token"),
    refresh: requiredString(token, "refresh_token"),
    expires: Date.now() + lifetime * 1000 - 60_000,
    clientId,
    identity,
    idToken,
    scopes,
  };
}
async function tokenRequest(fields: Record<string, string>, signal?: AbortSignal): Promise<Json> {
  const response = await oauthRequest(`${AUTH_BASE}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields),
    signal,
  });
  if (!response.ok)
    throw new Error(`ChatGPT sign-in failed (HTTP ${response.status}). Start sign-in again.`);
  return response.body;
}
async function revoke(credential: OAuthCredential): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REVOKE_TIMEOUT_MS);
  try {
    return await revokeWithin(credential, abort.signal);
  } finally {
    clearTimeout(timer);
  }
}
async function revokeWithin(credential: OAuthCredential, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    try {
      const discovery = await oauthRequest(`${AUTH_BASE}/.well-known/openid-configuration`, {
        signal,
      });
      if (!discovery.ok) {
        if (discovery.status < 500) return false;
        continue;
      }
      const config = discovery.body;
      const url = new URL(requiredString(config, "revocation_endpoint"));
      if (config.issuer !== AUTH_BASE || url.origin !== AUTH_BASE || url.protocol !== "https:")
        return false;
      const response = await oauthRequest(
        url.href,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: credential.refresh,
            token_type_hint: "refresh_token",
            client_id: requiredString(credential, "clientId"),
          }),
          signal,
        },
        false,
      );
      if (response.status === 200) return true;
      if (response.status < 500) return false;
    } catch {
      // Revocation is idempotent; retry transient transport/server failures only.
    }
  }
  return false;
}
function requiredString(body: Json, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value) throw new Error(`ChatGPT response is missing ${field}.`);
  return value;
}
function randomValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
