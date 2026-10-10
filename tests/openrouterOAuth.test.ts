import { afterEach, expect, test, vi } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials";
import {
  createPortableOpenRouterOAuth,
  portableOpenRouterOAuth,
  SIGN_IN_SUSPENDED,
} from "../src/providers/portableOAuth";
import { OPENROUTER_CALLBACK_URL, waitForOpenRouterCallback } from "../src/platform/oauthCallback";

const handlers = new Set<(event: Acode.IntentEvent & { url?: string }) => void>();
afterEach(() => {
  handlers.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function host() {
  const intent = {
    addHandler: (handler: (event: Acode.IntentEvent) => void) => handlers.add(handler),
    removeHandler: (handler: (event: Acode.IntentEvent) => void) => handlers.delete(handler),
  };
  vi.stubGlobal("acode", { require: (name: string) => (name === "intent" ? intent : undefined) });
}

function deliver(url: URL, legacy = false) {
  const event = {
    module: "ai-agent",
    action: "oauth",
    value: "openrouter" + url.search,
    ...(legacy ? {} : { url: url.href }),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    defaultPrevented: false,
    propagationStopped: false,
  };
  for (const handler of handlers) handler(event);
  return event;
}

test("a missing callback bridge offers an API key without requesting a return URL", async () => {
  const credentials = new PortableCredentialStore(null);
  const prompt = vi.fn();
  const notify = vi.fn();
  await expect(
    createPortableOpenRouterOAuth(credentials).login({ prompt, notify }),
  ).rejects.toThrow(/use an API key/);
  expect(prompt).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(await credentials.pendingSignIn("openrouter")).toBeUndefined();
});

test.each(["acode://ai-agent/oauth/openrouter", OPENROUTER_CALLBACK_URL])(
  "OpenRouter completes automatically via %s with matched state and PKCE",
  async (redirect) => {
    host();
    let authorize!: URL;
    const prompt = vi.fn();
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://openrouter.ai/api/v1/auth/keys");
      const body = JSON.parse(String(init?.body));
      expect(body.code).toBe("approved+code&value");
      expect(body.code_challenge_method).toBe("S256");
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(body.code_verifier),
      );
      expect(Buffer.from(hash).toString("base64url")).toBe(
        authorize.searchParams.get("code_challenge"),
      );
      return Response.json({ key: "sk-or-fixture" });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await portableOpenRouterOAuth.login({
      prompt,
      notify(event) {
        if (event.type !== "auth_url") return;
        authorize = new URL(event.url);
        const returnUrl = new URL(authorize.searchParams.get("callback_url")!);
        expect(returnUrl.origin + returnUrl.pathname).toBe(OPENROUTER_CALLBACK_URL);
        expect(returnUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorize.searchParams.has("state")).toBe(false);
        expect(handlers.size).toBe(1);
        const callback = new URL(redirect);
        callback.search = returnUrl.search;
        callback.searchParams.set("code", "approved+code&value");
        // The shipped host splits acode:// into module/action/value and has no url field.
        const eventResult = deliver(callback, redirect.startsWith("acode://"));
        expect(eventResult.preventDefault).toHaveBeenCalled();
        deliver(callback);
      },
    });
    expect(result.access).toBe("sk-or-fixture");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  },
);

test("a cold restart recovers PKCE from plugin secrets and clears it after exchange", async () => {
  host();
  const secrets = new Map<string, string>();
  const ctx = {
    getSecret: async (key: string, fallback: string) => secrets.get(key) ?? fallback,
    setSecret: async (key: string, value: string) => {
      secrets.set(key, value);
    },
  } as Acode.PluginContext;
  const pending = {
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    expiresAt: Date.now() + 60_000,
  };
  await new PortableCredentialStore(ctx).savePendingSignIn("openrouter", pending);
  const recovered = new PortableCredentialStore(ctx);
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).code_verifier).toBe(pending.verifier);
    return Response.json({ key: "sk-or-recovered" });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await createPortableOpenRouterOAuth(recovered).login({
    prompt: vi.fn(),
    notify(event) {
      if (event.type !== "auth_url") return;
      const returnUrl = new URL(new URL(event.url).searchParams.get("callback_url")!);
      expect(returnUrl.searchParams.get("state")).toBe(pending.state);
      const callback = new URL("acode://ai-agent/oauth/openrouter");
      callback.search = new URLSearchParams({ code: "approved", state: pending.state }).toString();
      deliver(callback, true);
    },
  });
  expect(result.access).toBe("sk-or-recovered");
  expect(await recovered.pendingSignIn("openrouter")).toBeUndefined();
  expect(secrets.get("oauth-pending:openrouter")).toBe("");
});

test("stale, duplicate-state and foreign callbacks cannot finish the active login", async () => {
  host();
  const state = "a".repeat(43);
  const signal = new AbortController();
  const promise = waitForOpenRouterCallback(state, signal.signal, () => {});
  for (const url of [
    `acode://ai-agent/oauth/openrouter?state=old&code=code`,
    `${OPENROUTER_CALLBACK_URL}?state=${state}&state=${state}&code=code`,
    `https://evil.test/ai/oauth/openrouter?state=${state}&code=code`,
    `https://dev.acode.app/ai/oauth/openrouter?state=${state}&code=code`,
    `https://acode.app.evil.test/ai/oauth/openrouter?state=${state}&code=code`,
    `acode://ai-agent/oauth/other?state=${state}&code=code`,
  ])
    expect(deliver(new URL(url)).preventDefault).not.toHaveBeenCalled();
  expect(handlers.size).toBe(1);
  signal.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(handlers.size).toBe(0);
});

test("OpenRouter denial retains callback-URL state and clears the pending sign-in", async () => {
  host();
  vi.useFakeTimers();
  const credentials = new PortableCredentialStore(null);
  await credentials.savePendingSignIn("openrouter", {
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    expiresAt: Date.now() + 100,
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  let ready!: () => void;
  const notified = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = createPortableOpenRouterOAuth(credentials).login({
    prompt: vi.fn(),
    notify(event) {
      if (event.type !== "auth_url") return;
      // OpenRouter adds the error to the callback URL without echoing OAuth state.
      const returnUrl = new URL(new URL(event.url).searchParams.get("callback_url")!);
      returnUrl.searchParams.set("error", "access_denied");
      const callback = new URL("acode://ai-agent/oauth/openrouter");
      callback.search = returnUrl.search;
      deliver(callback);
      ready();
    },
  });
  const check = expect(result).rejects.toThrow(/authorization was denied/);
  await notified;
  await vi.advanceTimersByTimeAsync(100);
  await check;
  expect(fetch).not.toHaveBeenCalled();
  expect(await credentials.pendingSignIn("openrouter")).toBeUndefined();
  expect(await credentials.read("openrouter")).toBeUndefined();
  expect(handlers.size).toBe(0);
});

test.each(["error=access_denied", "code=one&code=two", "code="])(
  "rejects an invalid state-bound result (%s) and releases the listener",
  async (query) => {
    host();
    const state = "a".repeat(43);
    const result = waitForOpenRouterCallback(state, undefined, () => {
      deliver(new URL(`acode://ai-agent/oauth/openrouter?state=${state}&${query}`));
    });
    await expect(result).rejects.toThrow();
    expect(handlers.size).toBe(0);
  },
);

test("an expired callback wait is bounded and cannot clear a newer saved sign-in", async () => {
  host();
  vi.useFakeTimers();
  const result = waitForOpenRouterCallback("a".repeat(43), undefined, () => {}, 100);
  const check = expect(result).rejects.toThrow(/expired/);
  await vi.advanceTimersByTimeAsync(100);
  await check;
  expect(handlers.size).toBe(0);
  const store = new PortableCredentialStore(null);
  await store.savePendingSignIn("openrouter", {
    state: "new",
    verifier: "verifier",
    expiresAt: Date.now() + 1000,
  });
  await store.clearPendingSignIn("openrouter", "old");
  expect((await store.pendingSignIn("openrouter"))?.state).toBe("new");
});

test.each(["cancel", "exchange-failure"])(
  "%s clears the saved verifier without creating a credential",
  async (scenario) => {
    host();
    const credentials = new PortableCredentialStore(null);
    const abort = new AbortController();
    const fetch = vi.fn(async () => Response.json({ error: "exchange failed" }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const result = createPortableOpenRouterOAuth(credentials).login({
      signal: abort.signal,
      prompt: vi.fn(),
      notify(event) {
        if (event.type !== "auth_url") return;
        if (scenario === "cancel") abort.abort();
        else {
          const returnUrl = new URL(new URL(event.url).searchParams.get("callback_url")!);
          const state = returnUrl.searchParams.get("state")!;
          deliver(new URL(`acode://ai-agent/oauth/openrouter?state=${state}&code=approved`));
        }
      },
    });
    await expect(result).rejects.toThrow();
    expect(await credentials.pendingSignIn("openrouter")).toBeUndefined();
    expect(await credentials.read("openrouter")).toBeUndefined();
    expect(handlers.size).toBe(0);
    if (scenario === "cancel") expect(fetch).not.toHaveBeenCalled();
  },
);

test("suspending for a plugin reload keeps the saved verifier for the next load", async () => {
  host();
  const credentials = new PortableCredentialStore(null);
  const abort = new AbortController();
  const result = createPortableOpenRouterOAuth(credentials).login({
    signal: abort.signal,
    prompt: vi.fn(),
    notify(event) {
      if (event.type === "auth_url") abort.abort(SIGN_IN_SUSPENDED);
    },
  });
  await expect(result).rejects.toThrow();
  expect((await credentials.pendingSignIn("openrouter"))?.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(handlers.size).toBe(0);
});
