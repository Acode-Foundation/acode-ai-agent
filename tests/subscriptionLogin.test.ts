import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

const login = vi.hoisted(() => vi.fn());
const hydrate = vi.hoisted(() => vi.fn());
vi.mock("../src/providers/providerRegistry", () => ({
  ProviderRegistry: class {
    models = { login };
    syncCustomEndpoints() {}
  },
}));
vi.mock("../src/session/chatStore", () => ({
  ChatStore: class {
    hydrate = hydrate;
    list() {
      return [];
    }
  },
}));
import { AgentController } from "../src/app/agentController";

type LoginOptions = {
  signal: AbortSignal;
  notify(event: AuthEvent): void;
  prompt(prompt: AuthPrompt): Promise<string>;
};
let controller: AgentController;
let document: EventTarget;
let closedIds: string[];
let tabs: Array<{
  url: string;
  success: (event?: { type: string }) => void;
  error: (message: string) => void;
}>;

beforeEach(() => {
  document = new EventTarget();
  tabs = [];
  closedIds = [];
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("cordova", {
    exec(
      success: () => void,
      error: (message: string) => void,
      service: string,
      action: string,
      args: string[],
    ) {
      if (action === "close") closedIds.push(args[0]);
      else tabs.push({ url: args[0], success, error });
      success();
    },
  });
  controller = new AgentController(null);
  vi.spyOn(controller, "selectProvider").mockResolvedValue();
});
afterEach(async () => {
  await controller.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  login.mockReset();
  hydrate.mockReset();
  vi.useRealTimers();
});

test("closing a custom tab preserves a pending sign-in prompt", async () => {
  let submitted: string | undefined;
  login.mockImplementation(async (provider: string, kind: string, options: LoginOptions) => {
    options.notify({ type: "auth_url", url: "https://auth.example.test/?verifier=original" });
    submitted = await options.prompt({ type: "text", message: "Fixture prompt" });
    options.notify({ type: "progress", message: "Exchanging code" });
  });
  const result = controller.loginSubscription("openrouter");
  await vi.waitFor(() => expect(tabs).toHaveLength(1));
  expect(controller.state.authFlow?.browserReturned).toBe(false);
  tabs[0].success({ type: "closed" });
  expect(controller.state.authFlow).toMatchObject({
    browserReturned: true,
    prompt: { type: "text" },
  });
  await controller.openSignIn();
  expect(tabs[1].url).toBe(tabs[0].url);
  expect(login).toHaveBeenCalledTimes(1);
  expect(controller.state.authFlow?.browserReturned).toBe(false);
  document.dispatchEvent(new Event("resume"));
  expect(controller.state.authFlow?.browserReturned).toBe(true);
  controller.submitSubscriptionPrompt("fixture-answer");
  await result;
  expect(submitted).toBe("fixture-answer");
  expect(controller.state.authFlow?.status).toBe("connected");
  expect(closedIds.at(-1)).toMatch(/^\d+:\d+$/);
  tabs[1].success({ type: "closed" });
  expect(controller.state.authFlow?.status).toBe("connected");
});

test("a stale tab cannot restore a replacement sign-in or overwrite its error", async () => {
  login.mockImplementation(async (provider: string, kind: string, options: LoginOptions) => {
    options.notify({ type: "auth_url", url: `https://auth.example.test/?attempt=${tabs.length}` });
    await options.prompt({ type: "text", message: "Fixture prompt" });
  });
  const first = controller.loginSubscription("openrouter");
  await vi.waitFor(() => expect(tabs).toHaveLength(1));
  const second = controller.loginSubscription("openrouter");
  await vi.waitFor(() => expect(tabs).toHaveLength(2));
  await first;
  tabs[0].success({ type: "closed" });
  tabs[0].error("Old browser failed");
  expect(controller.state.authFlow?.browserReturned).toBe(false);
  document.dispatchEvent(new Event("resume"));
  expect(controller.state.authFlow).toMatchObject({
    browserReturned: true,
    message: "Fixture prompt",
  });
  controller.cancelSubscriptionLogin();
  await second;
  expect(controller.state.authFlow).toBeUndefined();
  tabs[1].success({ type: "closed" });
  expect(controller.state.authFlow).toBeUndefined();
});

test("callback URL prompts are rejected without showing an input", async () => {
  login.mockImplementation(async (_id: string, _kind: string, options: LoginOptions) => {
    await options.prompt({ type: "manual_code", message: "Paste callback URL" });
  });
  await expect(controller.loginSubscription("openrouter")).rejects.toThrow(/automatic sign-in/);
  expect(controller.state.authFlow).toMatchObject({ status: "error" });
  expect(controller.state.authFlow?.prompt).toBeUndefined();
});

test("device-code polling retains its code and sign-in page after app resume", async () => {
  let notify!: LoginOptions["notify"];
  login.mockImplementation(async (provider: string, kind: string, options: LoginOptions) => {
    notify = options.notify;
    notify({
      type: "device_code",
      userCode: "ABCD",
      verificationUri: "https://auth.example.test/device",
    });
    await new Promise((resolve, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Cancelled", "AbortError")),
        { once: true },
      ),
    );
  });
  const result = controller.loginSubscription("github-copilot");
  document.dispatchEvent(new Event("resume"));
  notify({ type: "info", message: "Checking approval" });
  expect(controller.state.authFlow).toMatchObject({
    browserReturned: true,
    userCode: "ABCD",
    verificationUri: "https://auth.example.test/device",
  });
  controller.cancelSubscriptionLogin();
  await result;
});

test("a browser launch failure restores the button and preserves the pending prompt", async () => {
  vi.stubGlobal("cordova", {
    exec(success: unknown, error: (message: string) => void) {
      error("A browser cannot be opened right now");
    },
  });
  login.mockImplementation(async (provider: string, kind: string, options: LoginOptions) => {
    options.notify({ type: "auth_url", url: "https://auth.example.test/" });
    await options.prompt({ type: "text", message: "Fixture prompt" });
  });
  const result = controller.loginSubscription("openrouter");
  await vi.waitFor(() => expect(controller.state.authFlow?.browserReturned).toBe(true));
  expect(controller.state.authFlow?.message).toBe("A browser cannot be opened right now");
  expect(controller.state.authFlow?.prompt?.type).toBe("text");
  controller.cancelSubscriptionLogin();
  await result;
});

test("startup waits for the recovered callback listener before continuing plugin initialization", async () => {
  const pending = {
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    expiresAt: Date.now() + 60_000,
  };
  await controller.credentials.savePendingSignIn("openrouter", pending);
  let ready!: () => void;
  login.mockImplementation(async (provider: string, kind: string, options: LoginOptions) => {
    await new Promise<void>((resolve) => {
      ready = resolve;
    });
    options.notify({ type: "auth_url", url: "https://auth.example.test/restored" });
    await options.prompt({ type: "text", message: "Fixture checkpoint" });
  });
  hydrate.mockRejectedValueOnce(new Error("Startup checkpoint"));
  const initialized = controller.initialize();
  const checkpoint = expect(initialized).rejects.toThrow("Startup checkpoint");
  await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  expect(hydrate).not.toHaveBeenCalled();
  ready();
  await checkpoint;
  expect(controller.state.authFlow).toMatchObject({
    browserReturned: true,
    verificationUri: "https://auth.example.test/restored",
  });
  expect(tabs).toHaveLength(0);
  expect((await controller.credentials.pendingSignIn("openrouter"))?.state).toBe(pending.state);
  controller.cancelSubscriptionLogin();
});

test("a recovered sign-in that completes during startup waits before selecting models", async () => {
  await controller.credentials.savePendingSignIn("openrouter", {
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    expiresAt: Date.now() + 60_000,
  });
  login.mockResolvedValueOnce(undefined);
  let failHydrate!: (error: Error) => void;
  hydrate.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        failHydrate = reject;
      }),
  );
  const initialized = controller.initialize();
  await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
  expect(controller.state.authFlow?.status).toBe("connecting");
  expect(controller.selectProvider).not.toHaveBeenCalled();
  failHydrate(new Error("Startup checkpoint"));
  await expect(initialized).rejects.toThrow("Startup checkpoint");
  await vi.waitFor(() => expect(controller.state.authFlow?.status).toBe("connected"));
  expect(controller.selectProvider).toHaveBeenCalledWith("openrouter");
});

test("startup proceeds when the recovered sign-in never becomes ready", async () => {
  vi.useFakeTimers();
  await controller.credentials.savePendingSignIn("openrouter", {
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    expiresAt: Date.now() + 60_000,
  });
  login.mockImplementation(
    (_provider: string, _kind: string, options: LoginOptions) =>
      new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve())),
  );
  hydrate.mockRejectedValueOnce(new Error("Startup checkpoint"));
  const initialized = controller.initialize();
  const checkpoint = expect(initialized).rejects.toThrow("Startup checkpoint");
  await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  expect(hydrate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  await checkpoint;
  expect(hydrate).toHaveBeenCalledTimes(1);
  controller.cancelSubscriptionLogin();
});

test("failed background sign-in stays in the provider UI without a global error", async () => {
  await controller.credentials.savePendingSignIn("openrouter", {
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    expiresAt: Date.now() + 60_000,
  });
  login.mockRejectedValueOnce(new Error("Sign-in unavailable"));
  hydrate.mockRejectedValueOnce(new Error("Startup checkpoint"));
  await expect(controller.initialize()).rejects.toThrow("Startup checkpoint");
  expect(controller.state.authFlow).toMatchObject({
    status: "error",
    message: "Sign-in unavailable",
  });
  expect(controller.state.error).toBeUndefined();
});

test("Copilot starts standard login without an Enterprise domain prompt", async () => {
  let answer: string | undefined;
  login.mockImplementation(async (_id: string, _kind: string, options: LoginOptions) => {
    answer = await options.prompt({ type: "text", message: "Enterprise domain" });
  });
  await controller.loginSubscription("github-copilot");
  expect(answer).toBe("");
  expect(controller.state.authFlow?.status).toBe("connected");
});

test("advanced Copilot login keeps the optional Enterprise domain", async () => {
  let answer: string | undefined;
  login.mockImplementation(async (id: string, kind: string, options: LoginOptions) => {
    answer = await options.prompt({ type: "text", message: "Enterprise domain" });
  });
  const result = controller.loginSubscription("github-copilot", false, true);
  await vi.waitFor(() => expect(controller.state.authFlow?.prompt?.type).toBe("text"));
  controller.submitSubscriptionPrompt("company.ghe.com");
  await result;
  expect(answer).toBe("company.ghe.com");
});

test.each(["openai-codex", "github-copilot", "xai", "kimi-coding"])(
  "%s shows its code before opening and closes the browser immediately after approval",
  async (provider) => {
    let notify!: LoginOptions["notify"];
    let finish!: () => void;
    login.mockImplementation(async (id: string, kind: string, options: LoginOptions) => {
      notify = options.notify;
      notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const result = controller.loginSubscription(provider);
    await vi.waitFor(() => expect(controller.state.authFlow?.userCode).toBe("ABCD-EFGH"));
    expect(tabs).toHaveLength(0);
    expect(controller.state.authFlow?.browserReturned).toBe(true);
    await controller.openSignIn();
    expect(tabs).toHaveLength(1);
    expect(controller.state.authFlow?.browserReturned).toBe(false);
    notify({ type: "progress", message: "Finishing secure sign-in…" });
    expect(closedIds).toHaveLength(1);
    expect(controller.state.authFlow?.status).toBe("connecting");
    expect(controller.state.authFlow?.verificationUri).toBeUndefined();
    finish();
    await result;
    expect(controller.state.authFlow?.status).toBe("connected");
  },
);

test("received credentials stay in the connecting phase until model loading completes", async () => {
  let finish!: () => void;
  vi.mocked(controller.selectProvider).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  login.mockResolvedValue({ type: "oauth", access: "fixture-token" });
  const result = controller.loginSubscription("openrouter");
  await vi.waitFor(() => expect(controller.selectProvider).toHaveBeenCalled());
  expect(controller.state.authFlow).toMatchObject({
    status: "connecting",
    message: "Signed in. Loading your models…",
  });
  finish();
  await result;
  expect(controller.state.authFlow?.status).toBe("connected");
});

test.each(["cancel", "dispose"])(
  "%s closes its auth browser before aborting listeners",
  async (action) => {
    login.mockImplementation(async (id: string, kind: string, options: LoginOptions) => {
      options.notify({
        type: "device_code",
        userCode: "code",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
    });
    const result = controller.loginSubscription("xai");
    await controller.openSignIn();
    if (action === "dispose") await controller.dispose();
    else controller.cancelSubscriptionLogin();
    await result;
    expect(closedIds).toHaveLength(1);
    if (action === "cancel") expect(controller.state.authFlow).toBeUndefined();
  },
);
