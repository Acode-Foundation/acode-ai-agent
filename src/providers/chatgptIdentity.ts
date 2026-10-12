import { oauthRequest } from "../platform/oauthRequest";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export type ChatGPTIdentity = { issuer: string; subject: string; email?: string; name?: string };

/** Verify a public-client ID token against OpenAI's pinned issuer/JWKS. */
export async function verifyChatGPTIdentity(
  token: string,
  clientId: string,
  nonce?: string,
  signal?: AbortSignal,
): Promise<ChatGPTIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ChatGPT returned an invalid ID token.");
  const header = decode(parts[0]!);
  const claims = decode(parts[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw new Error("ChatGPT returned an unsupported ID token signature.");
  const response = await oauthRequest(`${CHATGPT_ISSUER}/.well-known/jwks.json`, { signal });
  if (!response.ok)
    throw new Error(`ChatGPT identity verification failed (HTTP ${response.status}).`);
  const jwks = response.body as { keys?: (JsonWebKey & { kid?: string })[] };
  const key = jwks.keys?.find(
    (key) =>
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (!key.alg || key.alg === "RS256") &&
      (!key.use || key.use === "sig"),
  );
  if (!key) throw new Error("ChatGPT identity signing key was not found. Try again.");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    bytes(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !valid ||
    claims.iss !== CHATGPT_ISSUER ||
    !audiences.includes(clientId) ||
    (audiences.length > 1 && claims.azp !== clientId) ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now + 60) ||
    (nonce !== undefined && claims.nonce !== nonce) ||
    typeof claims.sub !== "string" ||
    !claims.sub
  )
    throw new Error("ChatGPT identity verification failed. Start sign-in again.");
  return {
    issuer: CHATGPT_ISSUER,
    subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("ChatGPT returned an invalid ID token.");
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
function decode(value: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(bytes(value))) as Record<string, unknown>;
  } catch {
    throw new Error("ChatGPT returned an invalid ID token.");
  }
}
