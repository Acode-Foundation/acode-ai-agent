import { afterEach, expect, test, vi } from "vitest";
import { portableCodexOAuth } from "../src/providers/portableOAuth.ts";

afterEach(() => vi.unstubAllGlobals());

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
