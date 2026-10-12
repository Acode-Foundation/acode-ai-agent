import { afterEach, expect, test, vi } from "vitest";
import { portableCodexOAuth } from "../src/providers/portableOAuth.ts";
import { installNativeFetch, uninstallNativeFetch } from "../src/platform/nativeHttp.ts";

afterEach(() => {
  uninstallNativeFetch();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("cancelled device sign-in makes no authentication request", async () => {
  const abort = new AbortController();
  abort.abort();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    portableCodexOAuth.login({ signal: abort.signal, notify: vi.fn(), prompt: vi.fn() }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

test("device sign-in completes after approval without a pasted callback", async () => {
  vi.useFakeTimers();
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
  const events: string[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/usercode"))
      return Response.json({ device_auth_id: "device", user_code: "ABCD-EFGH", interval: 1 });
    if (input.endsWith("/deviceauth/token"))
      return Response.json({
        authorization_code: "approved-code",
        code_verifier: "device-verifier",
      });
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
      prompt: vi.fn(() => {
        throw new Error("Device sign-in must not prompt");
      }),
      notify(event) {
        events.push(event.type);
      },
    });
    await vi.runAllTimersAsync();
    expect((await login).accountId).toBe("account");
    expect(events).toEqual(["device_code", "progress"]);
  } finally {
    vi.useRealTimers();
  }
});

test("device denial fails promptly instead of polling for fifteen minutes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input.endsWith("/usercode")
        ? Response.json({ device_auth_id: "device", user_code: "code", interval: 1 })
        : Response.json({ error: "access_denied" }, { status: 403 }),
    ),
  );
  try {
    const login = portableCodexOAuth.login({
      prompt: vi.fn(() => {
        throw new Error("Device sign-in must not prompt");
      }),
      notify() {},
    });
    const result = expect(login).rejects.toThrow(/Settings → Security/);
    await vi.runAllTimersAsync();
    await result;
  } finally {
    vi.useRealTimers();
  }
});

test.each(["stream", "buffered"])(
  "%s Android HTTP survives DNS failures during approval and token exchange",
  async (transport) => {
    vi.useFakeTimers();
    const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
    const attempts = new Map<string, number>();
    const dnsError =
      'Unable to resolve host "auth.openai.com": No address associated with hostname';
    const request = async (url: string, body?: string) => {
      const path = new URL(url).pathname;
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      if (path.endsWith("/usercode"))
        return Response.json({ device_auth_id: "device", user_code: "ABCD-EFGH", interval: 1 });
      if (path.endsWith("/deviceauth/token")) {
        expect(JSON.parse(body!)).toEqual({ device_auth_id: "device", user_code: "ABCD-EFGH" });
        if (attempt <= 2) throw new Error(dnsError);
        return Response.json({ authorization_code: "approved", code_verifier: "verifier" });
      }
      if (path.endsWith("/oauth/token")) {
        expect(new URLSearchParams(body).get("code")).toBe("approved");
        if (attempt === 1) throw new Error(dnsError);
        return Response.json({ access_token: access, refresh_token: "refresh", expires_in: 3600 });
      }
      return Response.json({ models: [{ slug: "available-model", visibility: "list" }] });
    };
    if (transport === "stream") {
      vi.stubGlobal("system", {
        httpStream: (url: string, options: { body?: string }) => request(url, options.body),
      });
    } else {
      vi.stubGlobal("cordova", {
        plugin: {
          http: {
            sendRequest(
              url: string,
              options: { data?: string },
              success: (response: { status: number; data: string }) => void,
              failure: (error: { status: number; error: string }) => void,
            ) {
              void request(url, options.data).then(
                async (response) => {
                  success({ status: response.status, data: await response.text() });
                },
                () => failure({ status: -3, error: `Host could not be resolved: ${dnsError}` }),
              );
              return 1;
            },
            abort() {},
          },
        },
      });
    }
    installNativeFetch();
    const notify = vi.fn();
    const login = portableCodexOAuth.login({ prompt: vi.fn(), notify });
    const result = expect(login).resolves.toMatchObject({
      accountId: "account",
      refresh: "refresh",
    });
    await vi.runAllTimersAsync();
    await result;
    expect(attempts.get("/api/accounts/deviceauth/token")).toBe(3);
    expect(attempts.get("/oauth/token")).toBe(2);
    expect(notify.mock.calls.map(([event]) => event.type)).toEqual(["device_code", "progress"]);
  },
);

test.each(["cancel", "expire"])("DNS retry stops when device sign-in must %s", async (ending) => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const abort = new AbortController();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/usercode"))
      return Response.json({ device_auth_id: "device", user_code: "code", interval: 1 });
    throw new Error(
      'Unable to resolve host "auth.openai.com": No address associated with hostname',
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const login = portableCodexOAuth.login({
    signal: abort.signal,
    notify: vi.fn(),
    prompt: vi.fn(),
  });
  const result =
    ending === "cancel"
      ? expect(login).rejects.toMatchObject({ name: "AbortError" })
      : expect(login).rejects.toThrow("Device authorization expired");
  await vi.advanceTimersByTimeAsync(1000);
  if (ending === "cancel") abort.abort();
  await vi.runAllTimersAsync();
  await result;
  expect(vi.getTimerCount()).toBe(0);
  if (ending === "cancel") expect(fetchMock).toHaveBeenCalledTimes(2);
  else expect(Date.now()).toBe(startedAt + 15 * 60 * 1000);
});

test.each(["transport", "http"])("token exchange does not replay %s failures", async (failure) => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/usercode"))
      return Response.json({ device_auth_id: "device", user_code: "code", interval: 1 });
    if (url.endsWith("/deviceauth/token"))
      return Response.json({ authorization_code: "approved", code_verifier: "verifier" });
    if (failure === "transport") throw new Error("connection lost");
    return Response.json(
      { error: "invalid_grant", error_description: 'Unable to resolve host "auth.openai.com"' },
      { status: 401 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const login = portableCodexOAuth.login({ notify: vi.fn(), prompt: vi.fn() });
  const result = expect(login).rejects.toThrow(
    failure === "transport" ? "connection lost" : "HTTP 401",
  );
  await vi.runAllTimersAsync();
  await result;
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/oauth/token"))).toHaveLength(1);
});
