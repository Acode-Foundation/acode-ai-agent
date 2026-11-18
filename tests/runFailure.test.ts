import type { LiveState } from "@earendil-works/pi-durable";
import { afterEach, assert, expect, test, vi } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials";
import { ProviderRegistry } from "../src/providers/providerRegistry";
import { describeUnanswered, failureNotice } from "../src/session/runFailure";

const failure = (reason: string, detail?: string) =>
  ({ taskId: 1, inputs: [], reason, detail }) as unknown as LiveState["runFailure"];

afterEach(() => vi.unstubAllGlobals());

test("a provider error offers Retry, and Sign in when the login was rejected", () => {
  const oauth =
    "OAuth refresh failed for xai: auth.x.ai authentication failed (HTTP 400): Invalid or unknown refresh token";
  expect(failureNotice(failure("model_error"), oauth)).toEqual({
    title: "Request failed",
    message: oauth,
    retryable: true,
    signIn: true,
  });
  expect(failureNotice(failure("model_error"), "429 Too Many Requests")).toMatchObject({
    retryable: true,
    signIn: false,
  });
});

test("stops by the user are not failures, and resets are not retried", () => {
  expect(failureNotice(failure("aborted"), undefined)).toBeUndefined();
  expect(failureNotice(undefined, "error")).toBeUndefined();
  expect(failureNotice(failure("reset"), undefined)?.retryable).toBe(false);
  expect(failureNotice(failure("nothing_to_answer"), undefined)?.retryable).toBe(false);
});

test.each([
  { message: "api.github.com (HTTP 403): No access to GitHub Copilot found.", signIn: false },
  { message: "api.github.com access denied (HTTP 403)", signIn: false },
  { message: "Provider access denied", signIn: false },
  { message: "403 Model not enabled for your plan", signIn: false },
  { message: "403 Region not supported", signIn: false },
  { message: "403 Access denied by organization policy", signIn: false },
  { message: "403 Blocked by content moderation", signIn: false },
  { message: "403 Invalid API key", signIn: true },
  { message: "401 Request failed", signIn: true },
  { message: "OAuth refresh failed for github-copilot: HTTP 403 access denied", signIn: true },
  { message: "api.github.com (HTTP 403): API rate limit exceeded", signIn: false },
  { message: "OAuth refresh failed (HTTP 429): Slow down", signIn: false },
])("offers Sign in only for authentication errors: $message", ({ message, signIn }) => {
  expect(failureNotice(failure("model_error"), message)).toMatchObject({ signIn, retryable: true });
});

test.each([
  { error: "invalid_grant" },
  { error: "invalid_grant", error_description: "Grant expired" },
])("OAuth refresh failures retain Sign in through the SDK: %j", async (body) => {
  const fetch = vi.fn(async () => Response.json(body, { status: 400 }));
  vi.stubGlobal("fetch", fetch);
  const credentials = new PortableCredentialStore(null);
  await credentials.modify("xai", async () => ({
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: 0,
  }));
  const registry = new ProviderRegistry(credentials);
  const model = registry.getModels("xai")[0];
  assert(model, "Expected an xAI model in the bundled catalog");
  const response = await registry.models.completeSimple(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
    { maxRetries: 0 },
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain("OAuth refresh failed for xai");
  expect(response.errorMessage).toContain(body.error_description ?? body.error);
  expect(failureNotice(failure("model_error"), response.errorMessage)?.signIn).toBe(true);
});

test("Pi's detail explains the failure, with a plain fallback", () => {
  expect(failureNotice(failure("turn_limit", "40 turns"), "40 turns")).toMatchObject({
    title: "Tool round limit reached",
    message: "Stopped after 40 tool rounds. Retry to continue, or raise the limit in Pi settings.",
    retryable: true,
  });
  expect(describeUnanswered("turn_limit", "1 turn")).toMatch(/^Stopped after 1 tool round\./);
  expect(describeUnanswered("interrupted", undefined)).toBe(
    "The app stopped while the model was answering.",
  );
  expect(describeUnanswered("model_error", { message: "boom" })).toBe("boom");
  expect(describeUnanswered("weird", undefined)).toBe("The prompt was not answered (weird).");
});
