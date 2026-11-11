import { afterEach, beforeEach, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({ init: vi.fn(), fetchAds: vi.fn(), created: vi.fn() }));
vi.mock("@elo-ads/web-sdk/core", () => ({
  EloSDK: class {
    constructor(config: unknown) {
      sdk.created(config);
    }
    init = sdk.init;
    fetchAds = sdk.fetchAds;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.clearAllMocks();
  sdk.init.mockResolvedValue({ status: "ready" });
  sdk.fetchAds.mockResolvedValue({ ad: null });
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("acode", { require: () => ({ HAS_PRO: false }) });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "acode.ai-agent.sponsors.v1" ? "allowed" : null),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(["pro", "declined", "hidden", "ios-unconfigured"])(
  "does not initialize SDK when %s",
  async (condition) => {
    if (condition === "pro") vi.stubGlobal("acode", { require: () => ({ HAS_PRO: true }) });
    if (condition === "declined") vi.stubGlobal("localStorage", { getItem: () => "declined" });
    if (condition === "hidden") vi.stubGlobal("document", { hidden: true });
    if (condition === "ios-unconfigured") vi.stubGlobal("cordova", { platformId: "ios" });
    const { loadSponsor } = await import("../src/ads/elo");
    expect(await loadSponsor("Web development", new AbortController().signal)).toBeNull();
    expect(sdk.created).not.toHaveBeenCalled();
  },
);

test("passes only the category and uses public SDK identifiers", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  await loadSponsor("Web development", new AbortController().signal);
  expect(sdk.created).toHaveBeenCalledExactlyOnceWith({
    publisherId: "test-publisher",
    adUnitId: "test-unit",
  });
  expect(sdk.fetchAds).toHaveBeenCalledExactlyOnceWith({
    signal: expect.any(AbortSignal),
    messages: [{ role: "summary", content: "Web development" }],
  });
});

test("honors SDK consent refusal and consent withdrawal during initialization", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  sdk.init.mockResolvedValueOnce({ status: "gdpr_consent_missing" });
  expect(await loadSponsor("Web development", new AbortController().signal)).toBeNull();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
  sdk.init.mockImplementationOnce(async () => {
    vi.stubGlobal("localStorage", { getItem: () => "declined" });
    return { status: "ready" };
  });
  expect(await loadSponsor("Web development", new AbortController().signal)).toBeNull();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
});

test("checks the WebView CMP signal before the SDK can write an ID or ping Elo", async () => {
  const values = new Map([
    ["acode.ai-agent.sponsors.v1", "allowed"],
    ["IABTCF_gdprApplies", "1"],
  ]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
  const { loadSponsor } = await import("../src/ads/elo");
  const signal = new AbortController().signal;
  expect(await loadSponsor("Web development", signal)).toBeNull();
  expect(sdk.init).not.toHaveBeenCalled();
  values.set("IABTCF_TCString", "test-consent");
  await loadSponsor("Web development", signal);
  expect(sdk.init).toHaveBeenCalledOnce();
});

test("creates a version 4 UUID with secure random bytes on older WebViews", async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const { loadSponsor } = await import("../src/ads/elo");
  await loadSponsor("Web development", new AbortController().signal);
  expect(crypto.randomUUID()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(sdk.fetchAds).toHaveBeenCalledOnce();
});

test("backgrounding during initialization defers the request until foreground", async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", doc);
  sdk.init.mockImplementationOnce(async () => {
    doc.hidden = true;
    return { status: "ready" };
  });
  const { loadSponsor } = await import("../src/ads/elo");
  const result = loadSponsor("Web development", new AbortController().signal);
  await Promise.resolve();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  await result;
  expect(sdk.fetchAds).toHaveBeenCalledOnce();
});

test("an aborted opportunity never initializes or requests an ad", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  const controller = new AbortController();
  controller.abort();
  expect(await loadSponsor("Web development", controller.signal)).toBeNull();
  expect(sdk.init).not.toHaveBeenCalled();
});

test("network failures and unsafe creatives leave the slot empty", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  sdk.fetchAds.mockRejectedValueOnce(new Error("Offline"));
  expect(await loadSponsor("Web development", new AbortController().signal)).toBeNull();
  sdk.fetchAds.mockResolvedValueOnce({ ad: { title: "Unsafe", click_url: "javascript:alert(1)" } });
  expect(await loadSponsor("Web development", new AbortController().signal)).toBeNull();
});
