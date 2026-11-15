import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  portableGitHubCopilotOAuth,
  portableKimiOAuth,
  portableXaiOAuth,
} from "../src/providers/portableOAuth";

const providers = [
  {
    name: "Copilot",
    oauth: portableGitHubCopilotOAuth,
    device: "https://github.com/login/device/code",
    token: "https://github.com/login/oauth/access_token",
  },
  {
    name: "Kimi",
    oauth: portableKimiOAuth,
    device: "https://auth.kimi.com/api/oauth/device_authorization",
    token: "https://auth.kimi.com/api/oauth/token",
  },
  {
    name: "xAI",
    oauth: portableXaiOAuth,
    device: "https://auth.x.ai/oauth2/device/code",
    token: "https://auth.x.ai/oauth2/token",
  },
];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(providers)(
  "$name polls pending/slow-down, then reports approval with a usable credential",
  async ({ name, oauth, device, token }) => {
    let polls = 0;
    const times: number[] = [];
    const notify = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === device) {
          expect(new URLSearchParams(String(init.body)).get("client_id")).toBeTruthy();
          return Response.json({
            device_code: "private-device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.example.test/device",
            verification_uri_complete: "https://auth.example.test/device?code=ABCD-EFGH",
            interval: 1,
            expires_in: 30,
          });
        }
        if (url === token) {
          const form = new URLSearchParams(String(init.body));
          expect(form.get("device_code")).toBe("private-device");
          expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
          times.push(Date.now());
          polls++;
          if (polls === 1) return Response.json({ error: "authorization_pending" });
          if (polls === 2) return Response.json({ error: "slow_down" }, { status: 400 });
          return Response.json({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
          });
        }
        if (url === "https://api.github.com/copilot_internal/v2/token")
          return Response.json({ token: "copilot-access", expires_at: Date.now() / 1000 + 3600 });
        if (url.endsWith("/models"))
          return Response.json({ data: [{ id: "gpt-fixture", model_picker_enabled: true }] });
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const result = oauth.login({ prompt: async () => "", notify });
    const checked = result.then((credential) => {
      expect(credential).toMatchObject({
        type: "oauth",
        access: name === "Copilot" ? "copilot-access" : "access",
      });
      expect(credential.refresh).toBe(name === "Copilot" ? "access" : "refresh");
    });
    await vi.runAllTimersAsync();
    await checked;
    expect(polls).toBe(3);
    expect(times[1]! - times[0]!).toBe(1000);
    expect(times[2]! - times[1]!).toBe(6000);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri:
          name === "Copilot"
            ? "https://auth.example.test/device"
            : "https://auth.example.test/device?code=ABCD-EFGH",
      }),
    );
    expect(notify).toHaveBeenLastCalledWith({
      type: "progress",
      message: "Finishing secure sign-in…",
    });
  },
);

test.each(providers)(
  "$name denial finishes without announcing approval",
  async ({ oauth, device }) => {
    const notify = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === device
          ? Response.json({
              device_code: "private-device",
              user_code: "code",
              verification_uri: "https://auth.example.test/",
              interval: 1,
              expires_in: 30,
            })
          : Response.json({ error: "access_denied" }, { status: 400 }),
      ),
    );
    const checked = expect(oauth.login({ prompt: async () => "", notify })).rejects.toThrow(
      /denied/,
    );
    await vi.runAllTimersAsync();
    await checked;
    expect(notify).toHaveBeenCalledTimes(1);
  },
);

test("expiration stops polling at the provider deadline", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      device_code: "private-device",
      user_code: "code",
      verification_uri: "https://auth.example.test/",
      interval: 5,
      expires_in: 1,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const checked = expect(
    portableKimiOAuth.login({ prompt: async () => "", notify() {} }),
  ).rejects.toThrow(/expired/);
  await vi.runAllTimersAsync();
  await checked;
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { body: { message: "API rate limit exceeded" }, detail: "API rate limit exceeded" },
  { body: { message: "x".repeat(500) }, detail: "x".repeat(160) },
  { body: { message: "  Access\n\tdenied  " }, detail: "Access denied" },
  { body: { message: " \n " }, detail: "access denied" },
  { body: {}, detail: "access denied" },
  { body: {}, detail: "authentication failed", status: 401 },
  { body: {}, detail: "request failed", status: 429 },
  { body: null, detail: "access denied" },
  { body: { error_details: "invalid", message: "Denied" }, detail: "Denied" },
  { body: { error_details: {}, message: "Denied" }, detail: "Denied" },
  { body: { error_description: "Expired token" }, detail: "Expired token", status: 401 },
  { body: { message: "Slow down" }, detail: "Slow down", status: 429 },
  {
    body: { error: { message: "Copilot access is disabled for this account" } },
    detail: "Copilot access is disabled for this account",
  },
  {
    body: {
      message: "Resource not accessible by integration",
      error_details: { message: "No access to GitHub Copilot found." },
    },
    detail: "No access to GitHub Copilot found.",
  },
])(
  "Copilot reports token rejection details after browser approval: $detail",
  async ({ body, detail, status = 403 }) => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://github.com/login/device/code")
        return Response.json({
          device_code: "device",
          user_code: "code",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 30,
        });
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "github-access" });
      if (url === "https://api.github.com/copilot_internal/v2/token")
        return Response.json(body, { status });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const result = expect(
      portableGitHubCopilotOAuth.login({ prompt: async () => "", notify: vi.fn() }),
    ).rejects.toMatchObject({ message: `api.github.com (HTTP ${status}): ${detail}` });
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

test("cancellation during polling prevents approval even if transport finishes late", async () => {
  const abort = new AbortController();
  const notify = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("device_authorization"))
        return Response.json({
          device_code: "private-device",
          user_code: "code",
          verification_uri: "https://auth.example.test/",
          interval: 1,
          expires_in: 30,
        });
      abort.abort();
      return Response.json({ access_token: "access", refresh_token: "refresh" });
    }),
  );
  const checked = expect(
    portableKimiOAuth.login({ signal: abort.signal, prompt: async () => "", notify }),
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.runAllTimersAsync();
  await checked;
  expect(notify).toHaveBeenCalledTimes(1);
});
