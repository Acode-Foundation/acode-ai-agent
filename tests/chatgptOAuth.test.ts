import { afterEach, expect, test, vi } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials";
import { ChatGPTAccount, createChatGPTOAuth } from "../src/providers/chatgptOAuth";
import { verifyChatGPTIdentity } from "../src/providers/chatgptIdentity";
import { startLoopbackOAuth } from "../src/platform/loopbackOAuth";
import { oauthRequest } from "../src/platform/oauthRequest";
import { browserLoopbackPages } from "../src/platform/browserLoopback";
import { runInNewContext } from "node:vm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function serverFixture() {
  let handler: (request: unknown) => void = () => {};
  const server = {
    port: 0,
    stop: vi.fn((done: () => void) => done()),
    send: vi.fn(),
    setOnRequestHandler: vi.fn((next: typeof handler) => {
      handler = next;
    }),
  };
  vi.stubGlobal("CreateServer", (port: number, ready: () => void) => {
    server.port = port;
    queueMicrotask(ready);
    return server;
  });
  return {
    server,
    callback(query: URLSearchParams, path = "/auth/callback") {
      handler({ requestId: "request", method: "GET", path, query: query.toString() });
    },
  };
}

async function signer() {
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "test-key" };
  return {
    jwk,
    async token(claims: Record<string, unknown>) {
      const prefix = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")}.${Buffer.from(
        JSON.stringify({
          iss: "https://auth.openai.com",
          sub: "subject",
          aud: "issued-client",
          exp: Date.now() / 1000 + 3600,
          email: "user@example.test",
          ...claims,
        }),
      ).toString("base64url")}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key.privateKey,
        new TextEncoder().encode(prefix),
      );
      return `${prefix}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

test("native callback validates state, path, unique parameters and returning client before settling", async () => {
  const { server, callback } = serverFixture();
  const listener = await startLoopbackOAuth("expected", "issued-client");
  const wrong = new URLSearchParams({ state: "wrong", code: "code", client_id: "issued-client" });
  callback(wrong);
  expect(server.send.mock.calls.at(-1)?.[1]).toMatchObject({ status: 400 });
  wrong.set("state", "expected");
  callback(wrong, "/callback");
  expect(server.send.mock.calls.at(-1)?.[1]).toMatchObject({ status: 404 });
  wrong.set("client_id", "different-client");
  callback(wrong);
  expect(server.send.mock.calls.at(-1)?.[1]).toMatchObject({ status: 400 });
  wrong.delete("client_id");
  wrong.append("state", "expected");
  callback(wrong);
  expect(server.send.mock.calls.at(-1)?.[1]).toMatchObject({ status: 400 });
  wrong.delete("state");
  wrong.set("state", "expected");
  callback(wrong);
  await expect(listener.result).resolves.toEqual({ code: "code", clientId: "issued-client" });
  expect(server.send.mock.calls.at(-1)?.[1]).toMatchObject({ status: 200 });
  const page = JSON.stringify(server.send.mock.calls.at(-1)?.[1]);
  expect(page).toContain("acode://ai-agent/oauth/chatgpt");
  expect(page).not.toContain("expected");
  await listener.close();
  expect(server.stop).toHaveBeenCalledOnce();
});

test.each(["denied", "cancelled", "expired"])(
  "native callback releases the server when %s",
  async (ending) => {
    vi.useFakeTimers();
    const { server, callback } = serverFixture();
    const abort = new AbortController();
    const starting = startLoopbackOAuth("expected", undefined, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    const listener = await starting;
    const result = expect(listener.result).rejects.toThrow(
      ending === "denied" ? "denied" : ending === "expired" ? "expired" : "cancelled",
    );
    if (ending === "denied")
      callback(new URLSearchParams({ state: "expected", error: "access_denied" }));
    if (ending === "cancelled") abort.abort();
    if (ending === "expired") await vi.advanceTimersByTimeAsync(10 * 60_000);
    await result;
    await listener.close();
    expect(server.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("Android callback targets this Acode edition and consumes only its return intent", async () => {
  const { callback, server } = serverFixture();
  const intent = { addHandler: vi.fn(), removeHandler: vi.fn() };
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.stubGlobal("BuildInfo", { packageName: "com.foxdebug.acodefree" });
  vi.stubGlobal("acode", { require: () => intent });
  const listener = await startLoopbackOAuth("expected");
  const handler = intent.addHandler.mock.calls[0]![0];
  const event = {
    module: "ai-agent",
    action: "oauth",
    value: "openrouter",
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  handler(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  handler({ ...event, value: "chatgpt" });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  callback(new URLSearchParams({ state: "expected", code: "code", client_id: "issued-client" }));
  await listener.result;
  expect(server.send.mock.calls[0]![1].body).toContain(
    "intent://ai-agent/oauth/chatgpt#Intent;scheme=acode;package=com.foxdebug.acodefree;end",
  );
  await listener.close();
  expect(intent.removeHandler).toHaveBeenCalledWith(handler);
});

test("Android browser callback authorizes only the pending state and returning client", async () => {
  const { server } = serverFixture();
  const intent = { addHandler: vi.fn(), removeHandler: vi.fn() };
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.stubGlobal("acode", { require: () => intent });
  const listener = await startLoopbackOAuth("expected", "issued-client");
  const handler = intent.addHandler.mock.calls[0]![0];
  const event = (query: string) => ({
    module: "ai-agent",
    action: "oauth",
    value: `chatgpt?${query}`,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  const done = vi.fn();
  void listener.result.then(done);
  for (const query of [
    "state=wrong&code=code&client_id=issued-client",
    "state=expected&state=expected&code=code&client_id=issued-client",
    "state=expected&code=code&client_id=other-client",
    "state=expected&code=code&client_id=issued-client&access_token=secret",
  ])
    handler(event(query));
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  const valid = event("state=expected&code=code&client_id=issued-client");
  handler(valid);
  await expect(listener.result).resolves.toEqual({ code: "code", clientId: "issued-client" });
  expect(server.send).not.toHaveBeenCalled();
  expect(valid.preventDefault).toHaveBeenCalledOnce();
  await listener.close();
  expect(intent.removeHandler).toHaveBeenCalledWith(handler);
});

test("serialized browser worker serves a bound callback without contacting the app and unregisters", async () => {
  const pages = browserLoopbackPages(
    "https://auth.openai.com/authorize",
    "expected",
    "intent://ai-agent/oauth/chatgpt#Intent;scheme=acode;end",
    Date.now() + 60_000,
  );
  const handlers: Record<string, (event: unknown) => void> = {};
  const unregister = vi.fn().mockResolvedValue(true);
  runInNewContext(pages.worker, {
    URL,
    Response,
    Date,
    self: {
      addEventListener: (name: string, handler: (typeof handlers)[string]) => {
        handlers[name] = handler;
      },
      registration: { unregister },
    },
  });
  const respondWith = vi.fn();
  const waitUntil = vi.fn();
  handlers.fetch!({
    request: new Request("http://127.0.0.1:54321/auth/callback?state=wrong&code=code"),
    respondWith,
    waitUntil,
  });
  expect(respondWith.mock.calls[0]![0].status).toBe(400);
  expect(unregister).not.toHaveBeenCalled();
  handlers.fetch!({
    request: new Request("http://127.0.0.1:54321/auth/callback?state=expected&code=code"),
    respondWith,
    waitUntil,
  });
  const response = respondWith.mock.calls[1]![0] as Response;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toBe(pages.policy);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("Return to Acode");
  expect(unregister).toHaveBeenCalledOnce();
  expect(waitUntil).toHaveBeenCalledOnce();
});

test("browser setup times out even when worker registration hangs, without redirecting later", async () => {
  vi.useFakeTimers();
  const pages = browserLoopbackPages(
    "https://auth.openai.com/authorize",
    "expected",
    "intent://ai-agent/oauth/chatgpt#Intent;scheme=acode;end",
    Date.now() + 60_000,
  );
  const elements = Object.fromEntries(
    ["title", "indicator", "status", "return"].map((id) => [
      id,
      { textContent: "", dataset: {}, hidden: true },
    ]),
  );
  let registered!: (registration: unknown) => void;
  const replace = vi.fn();
  // The page is generated by us with exactly one inline script; slice it out rather than parse HTML.
  const scriptStart = pages.start.indexOf(">", pages.start.indexOf("<script")) + 1;
  const script = pages.start.slice(scriptStart, pages.start.lastIndexOf("</script>"));
  expect(scriptStart).toBeGreaterThan(0);
  expect(script).toContain("location.replace");
  const preparation = runInNewContext(script, {
    navigator: {
      serviceWorker: {
        register: () =>
          new Promise((resolve) => {
            registered = resolve;
          }),
      },
    },
    document: { getElementById: (id: string) => elements[id] },
    location: { replace },
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  });
  await vi.advanceTimersByTimeAsync(15_000);
  await preparation;
  expect(elements.title!.textContent).toBe("Sign-in could not start");
  expect(elements.return!.hidden).toBe(false);
  expect(replace).not.toHaveBeenCalled();
  const unregister = vi.fn().mockResolvedValue(true);
  registered({ active: { state: "activated" }, unregister });
  await vi.advanceTimersByTimeAsync(0);
  expect(unregister).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const nonce = pages.start.match(/<script nonce="([^"]+)"/)![1];
  expect(pages.startPolicy).toContain(`script-src 'nonce-${nonce}'`);
  expect(pages.startPolicy).toContain(`style-src 'nonce-${nonce}'`);
});

test("ChatGPT sign-in registers the app, verifies identity, discovers models and reuses registration after restart", async () => {
  const signing = await signer();
  const { callback, server } = serverFixture();
  let authorization!: URL;
  const requests: URLSearchParams[] = [];
  vi.stubGlobal("system", {
    httpStream: async (url: string, options: { body?: string }) => {
      if (url.endsWith("jwks.json")) return Response.json({ keys: [signing.jwk] });
      if (url.endsWith("/models"))
        return Response.json({
          models: [
            { slug: "gpt-test", display_name: "Test model", visibility: "list" },
            { slug: "hidden", visibility: "hide" },
          ],
        });
      const fields = new URLSearchParams(options.body);
      requests.push(fields);
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
        id_token: await signing.token({ nonce: authorization.searchParams.get("nonce") }),
      });
    },
  });
  const secrets = new Map<string, string>();
  const ctx = {
    getSecret: async (key: string) => secrets.get(key) ?? "",
    setSecret: async (key: string, value: string) => {
      secrets.set(key, value);
    },
  } as unknown as Acode.PluginContext;
  let store = new PortableCredentialStore(ctx);
  let accounts = new ChatGPTAccount(store);
  const notify = (event: { type: string; url?: string }) => {
    if (event.type !== "auth_url") return;
    authorization = new URL(event.url!);
    callback(
      new URLSearchParams({
        state: authorization.searchParams.get("state")!,
        code: "approved",
        client_id: "issued-client",
      }),
    );
  };
  const credential = await createChatGPTOAuth(accounts).login({
    signal: new AbortController().signal,
    prompt: vi.fn(),
    notify,
  });
  const hostId = authorization.searchParams.get("ext_agent_host_id");
  expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorization.searchParams.get("agent_name_hint")).toBe("Acode AI Agent");
  expect(requests[0]?.get("client_id")).toBe("issued-client");
  expect(requests[0]?.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
  expect(requests[0]?.get("code_verifier")).not.toBe(
    authorization.searchParams.get("code_challenge"),
  );
  expect(credential).toMatchObject({
    clientId: "issued-client",
    identity: { subject: "subject", email: "user@example.test" },
    availableModels: [{ id: "gpt-test", name: "Test model" }],
  });
  await store.modify("chatgpt", async () => credential);
  store = new PortableCredentialStore(ctx);
  accounts = new ChatGPTAccount(store);
  expect((await accounts.state()).registration).toEqual({
    clientId: "issued-client",
    identity: credential.identity,
  });
  const prompt = vi.fn();
  await createChatGPTOAuth(accounts).login({
    signal: new AbortController().signal,
    prompt,
    notify,
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(authorization.searchParams.get("client_id")).toBe("issued-client");
  expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
  expect(authorization.searchParams.get("ext_agent_host_id")).toBe(hostId);
  expect(authorization.searchParams.has("id_token_hint")).toBe(true);
  expect(server.stop).toHaveBeenCalledTimes(2);
  await accounts.disconnect();
  expect(await store.read("chatgpt")).toBeUndefined();
  await createChatGPTOAuth(accounts).login({
    signal: new AbortController().signal,
    prompt,
    notify,
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(authorization.searchParams.get("client_id")).toBe("issued-client");
  expect(authorization.searchParams.get("ext_agent_host_id")).toBe(hostId);
  expect(authorization.searchParams.has("id_token_hint")).toBe(false);
  expect(server.stop).toHaveBeenCalledTimes(3);
});

test.each(["signature", "issuer", "audience", "expiry", "nonce"])(
  "rejects an ID token with invalid %s",
  async (field) => {
    const signing = await signer();
    vi.stubGlobal("system", { httpStream: async () => Response.json({ keys: [signing.jwk] }) });
    const claims = {
      nonce: "expected",
      ...(field === "issuer" ? { iss: "https://attacker.test" } : {}),
      ...(field === "audience" ? { aud: "other-client" } : {}),
      ...(field === "expiry" ? { exp: 0 } : {}),
      ...(field === "nonce" ? { nonce: "wrong" } : {}),
    };
    let token = await signing.token(claims);
    if (field === "signature") token = `${token.split(".").slice(0, 2).join(".")}.AA`;
    await expect(verifyChatGPTIdentity(token, "issued-client", "expected")).rejects.toThrow(
      "verification failed",
    );
  },
);

test("rotating refresh persists tokens independently of registration storage", async () => {
  const store = new PortableCredentialStore(null);
  const accounts = new ChatGPTAccount(store);
  const identity = { issuer: "https://auth.openai.com", subject: "subject" };
  const current = {
    type: "oauth" as const,
    access: "old",
    refresh: "old-refresh",
    expires: 0,
    clientId: "issued-client",
    identity,
    scopes: ["chatgpt.tokens.use.direct"],
  };
  await accounts.save("issued-client", identity);
  await store.modify("chatgpt", async () => current);
  const saveRegistration = vi
    .spyOn(store, "updateOAuthState")
    .mockRejectedValue(new Error("Registration storage unavailable"));
  vi.stubGlobal("system", {
    httpStream: async (_url: string, options: { body?: string }) => {
      expect(new URLSearchParams(options.body).get("client_id")).toBe("issued-client");
      return Response.json({
        access_token: "new",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
      });
    },
  });
  await store.modify("chatgpt", async () =>
    createChatGPTOAuth(accounts).refresh(current, new AbortController().signal),
  );
  expect((await store.read("chatgpt"))?.refresh).toBe("new-refresh");
  expect(saveRegistration).not.toHaveBeenCalled();
  expect((await accounts.state()).registration).toEqual({ clientId: "issued-client", identity });
  expect(JSON.stringify(await accounts.state())).not.toContain("refresh");
});

test("refresh keeps the current refresh token and scopes when the response omits them", async () => {
  const accounts = new ChatGPTAccount(new PortableCredentialStore(null));
  const current = {
    type: "oauth" as const,
    access: "old",
    refresh: "kept-refresh",
    expires: 0,
    clientId: "issued-client",
    identity: { issuer: "https://auth.openai.com", subject: "subject" },
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  };
  vi.stubGlobal("system", {
    httpStream: async () =>
      Response.json({ access_token: "new", token_type: "Bearer", expires_in: 3600 }),
  });
  const refreshed = await createChatGPTOAuth(accounts).refresh(
    current,
    new AbortController().signal,
  );
  expect(refreshed).toMatchObject({
    access: "new",
    refresh: "kept-refresh",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  });
});

test("disconnect signs out locally before revocation and stops waiting after a bounded time", async () => {
  vi.useFakeTimers();
  const store = new PortableCredentialStore(null);
  const accounts = new ChatGPTAccount(store);
  await store.modify("chatgpt", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 0,
    clientId: "issued-client",
  }));
  vi.stubGlobal("system", {
    httpStream: (_url: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  });
  const disconnect = accounts.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(await store.read("chatgpt")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(disconnect).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([true, false])(
  "old saved profiles migrate to one account (connected=%s)",
  async (connected) => {
    const store = new PortableCredentialStore(null);
    const identity = { issuer: "https://auth.openai.com", subject: "active-user" };
    const credential = {
      type: "oauth" as const,
      access: "active-access",
      refresh: "active-refresh",
      expires: 0,
      clientId: "active-client",
      identity,
    };
    await store.updateOAuthState("chatgpt", () => ({
      hostId: "urn:uuid:existing-host",
      registrations: [
        { clientId: "active-client", identity, credential },
        {
          clientId: "other-client",
          identity: { ...identity, subject: "other-user" },
          credential: { ...credential, refresh: "other-refresh" },
        },
      ],
    }));
    if (connected) await store.modify("chatgpt", async () => credential);
    const accounts = new ChatGPTAccount(store);
    const state = await accounts.state();
    expect(state.hostId).toBe("urn:uuid:existing-host");
    expect(state.registration?.clientId).toBe(connected ? "active-client" : undefined);
    expect(state).not.toHaveProperty("registrations");
    expect(JSON.stringify(await store.oauthState("chatgpt"))).not.toContain("refresh");
    expect(await store.read("chatgpt")).toEqual(connected ? credential : undefined);
  },
);

test("removing a disconnected account keeps its host ID and starts a fresh registration", async () => {
  const store = new PortableCredentialStore(null);
  const accounts = new ChatGPTAccount(store);
  await accounts.save("old-client", { issuer: "https://auth.openai.com", subject: "old-user" });
  const hostId = (await accounts.state()).hostId;
  await accounts.forget();
  expect(await accounts.state()).toEqual({ hostId });
  const { callback } = serverFixture();
  const abort = new AbortController();
  const prompt = vi.fn();
  let authorization!: URL;
  const login = createChatGPTOAuth(accounts).login({
    signal: abort.signal,
    prompt,
    notify: (event) => {
      if (event.type === "auth_url") {
        authorization = new URL(event.url);
        callback(
          new URLSearchParams({
            state: authorization.searchParams.get("state")!,
            error: "access_denied",
          }),
        );
      }
    },
  });
  await expect(login).rejects.toThrow("denied");
  expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorization.searchParams.get("ext_agent_host_id")).toBe(hostId);
  expect(prompt).not.toHaveBeenCalled();
});

test("damaged registration metadata recovers from the active credential", async () => {
  const credential = {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 0,
    clientId: "issued-client",
    identity: { issuer: "https://auth.openai.com", subject: "subject" },
  };
  const secrets = new Map([
    ["provider:chatgpt", JSON.stringify(credential)],
    ["oauth-state:chatgpt", "{broken"],
  ]);
  const store = new PortableCredentialStore({
    getSecret: async (key: string) => secrets.get(key) ?? "",
    setSecret: async (key: string, value: string) => {
      secrets.set(key, value);
    },
  } as unknown as Acode.PluginContext);
  const account = new ChatGPTAccount(store);
  const state = await account.state();
  expect(state.registration).toEqual({ clientId: "issued-client", identity: credential.identity });
  expect((await account.state()).hostId).toBe(state.hostId);
  expect(await store.read("chatgpt")).toEqual(credential);
});

test("new requests are aborted while disconnect waits for revocation", async () => {
  const store = new PortableCredentialStore(null);
  const account = new ChatGPTAccount(store);
  await store.modify("chatgpt", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 0,
    clientId: "issued-client",
  }));
  let finish!: (response: Response) => void;
  const revoking = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("system", {
    httpStream: async (url: string) =>
      url.endsWith("openid-configuration")
        ? Response.json({
            issuer: "https://auth.openai.com",
            revocation_endpoint: "https://auth.openai.com/revoke",
          })
        : revoking(),
  });
  const disconnect = account.disconnect();
  await vi.waitFor(() => expect(revoking).toHaveBeenCalledOnce());
  const request = account.request();
  const aborted = request.signal.aborted;
  request.release();
  finish(new Response(null, { status: 200 }));
  await disconnect;
  expect(aborted).toBe(true);
});

test.each(["success", "transient", "network", "denied", "failed"])(
  "disconnect clears credentials and keeps only registration after %s revocation",
  async (outcome) => {
    const confirmed = ["success", "transient", "network"].includes(outcome);
    const store = new PortableCredentialStore(null);
    const accounts = new ChatGPTAccount(store);
    const credential = {
      type: "oauth" as const,
      access: "access",
      refresh: "latest-refresh",
      expires: Date.now() + 3600_000,
      clientId: "issued-client",
      identity: { issuer: "https://auth.openai.com", subject: "subject" },
    };
    await accounts.save("issued-client", credential.identity);
    await store.modify("chatgpt", async () => credential);
    let attempts = 0;
    const request = vi.fn(async (url: string, options: { body?: string }) => {
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
        });
      expect(new URLSearchParams(options.body).get("token")).toBe("latest-refresh");
      attempts++;
      if (outcome === "network" && attempts === 1) throw new Error("Network unavailable");
      return new Response(null, {
        status:
          outcome === "denied"
            ? 401
            : outcome === "failed" || (outcome === "transient" && attempts === 1)
              ? 503
              : 200,
      });
    });
    vi.stubGlobal("system", { httpStream: request });
    expect(await accounts.disconnect()).toBe(confirmed);
    expect(attempts).toBe(
      outcome === "failed" ? 3 : ["transient", "network"].includes(outcome) ? 2 : 1,
    );
    expect(await store.read("chatgpt")).toBeUndefined();
    expect((await accounts.state()).registration).toEqual({
      clientId: "issued-client",
      identity: credential.identity,
    });
    expect(JSON.stringify(await accounts.state())).not.toContain("refresh");
  },
);

test("OAuth request timeout aborts native I/O and releases its timers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("system", {
    httpStream: (_url: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  });
  const request = oauthRequest("https://auth.openai.com/api/accounts/oauth/token");
  const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
