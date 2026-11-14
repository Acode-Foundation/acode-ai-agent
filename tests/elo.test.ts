import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SponsorBudget, SponsorSession } from "../src/ads/session";

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

const dimensions = { maxHeight: 192, maxWidth: 320 };

beforeEach(() => {
  vi.stubGlobal("admob", {
    privacy: { getState: async () => ({ canRequestAds: true, consentStatus: "notRequired" }) },
  });
  vi.resetModules();
  vi.stubGlobal("ANDROID_SDK_INT", 35);
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.clearAllMocks();
  sdk.init.mockResolvedValue({ status: "ready" });
  sdk.fetchAds.mockResolvedValue({ ad: null });
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("acode", { require: () => ({ HAS_PRO: false }) });
  const values = new Map([["acode.ai-agent.sponsors.v1", "allowed"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(["pro", "declined", "hidden", "ios-unconfigured", "android-28"])(
  "does not initialize SDK when %s",
  async (condition) => {
    if (condition === "android-28") vi.stubGlobal("ANDROID_SDK_INT", 28);
    if (condition === "pro") vi.stubGlobal("acode", { require: () => ({ HAS_PRO: true }) });
    if (condition === "declined") vi.stubGlobal("localStorage", { getItem: () => "declined" });
    if (condition === "hidden") vi.stubGlobal("document", { hidden: true });
    if (condition === "ios-unconfigured") vi.stubGlobal("cordova", { platformId: "ios" });
    const { loadSponsor } = await import("../src/ads/elo");
    expect(
      await loadSponsor(["Web development"], new AbortController().signal, dimensions),
    ).toBeNull();
    expect(sdk.created).not.toHaveBeenCalled();
  },
);

test.each(["privacy", "getState"])("a throwing %s getter disables sponsorship", async (key) => {
  const broken = Object.defineProperty({}, key, {
    get() {
      throw Error("Bridge unavailable");
    },
  });
  vi.stubGlobal("admob", key === "privacy" ? broken : { privacy: broken });
  const { sponsorsConfigured } = await import("../src/ads/elo");
  const { hasSponsorConsentBridge, readSponsorConsent } = await import("../src/ads/consent");
  expect(sponsorsConfigured()).toBe(false);
  expect(hasSponsorConsentBridge()).toBe(false);
  expect((await readSponsorConsent(new AbortController().signal)).status).toBe("unavailable");
});

test.each(["missing", "rejecting", "empty topics"])(
  "avoids SDK initialization with %s",
  async (condition) => {
    const getState = vi.fn().mockRejectedValue(new Error("Bridge unavailable"));
    vi.stubGlobal("admob", condition === "missing" ? undefined : { privacy: { getState } });
    const { loadSponsor, sponsorsConfigured } = await import("../src/ads/elo");
    if (condition === "missing") expect(sponsorsConfigured()).toBe(false);
    expect(
      await loadSponsor(
        condition === "empty topics" ? [] : ["Web development"],
        new AbortController().signal,
        dimensions,
      ),
    ).toBeNull();
    expect(sdk.init).not.toHaveBeenCalled();
    if (condition === "empty topics") expect(getState).not.toHaveBeenCalled();
  },
);

test("passes only the category and uses public SDK identifiers", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  await loadSponsor(["Web development"], new AbortController().signal, dimensions);
  expect(sdk.created).toHaveBeenCalledExactlyOnceWith({
    publisherId: "test-publisher",
    adUnitId: "test-unit",
    baseUrl: "https://api.elo.ad",
  });
  expect(sdk.fetchAds).toHaveBeenCalledExactlyOnceWith({
    ...dimensions,
    context: [{ type: "topic", description: "Web development" }],
    signal: expect.any(AbortSignal),
    messages: [{ role: "summary", content: "Web development" }],
  });
});

test("a ready SDK uses one fresh native read per fetch and honors a later denial", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  const state = { canRequestAds: true, consentStatus: "notRequired" };
  const getState = vi.fn(async () => state);
  vi.stubGlobal("admob", { privacy: { getState } });
  const load = () => loadSponsor(["Web development"], new AbortController().signal, dimensions);
  await load();
  expect(getState).toHaveBeenCalledTimes(2);
  await load();
  expect(getState).toHaveBeenCalledTimes(3);
  state.canRequestAds = false;
  await load();
  expect(getState).toHaveBeenCalledTimes(4);
  expect(sdk.fetchAds).toHaveBeenCalledTimes(2);
});

test("honors SDK consent refusal and consent withdrawal during initialization", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  sdk.init.mockResolvedValueOnce({ status: "gdpr_consent_missing" });
  expect(
    await loadSponsor(["Web development"], new AbortController().signal, dimensions),
  ).toBeNull();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
  sdk.init.mockImplementationOnce(async () => {
    localStorage.setItem("acode.ai-agent.sponsors.v1", "declined");
    return { status: "ready" };
  });
  expect(
    await loadSponsor(["Web development"], new AbortController().signal, dimensions),
  ).toBeNull();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
  expect(sdk.init).toHaveBeenCalledTimes(2);
});

test("rechecks native consent after SDK initialization while the app stays visible", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  const native = {
    canRequestAds: true,
    consentStatus: "obtained",
    iabSignals: { IABTCF_gdprApplies: " 0 " },
  };
  vi.stubGlobal("admob", { privacy: { getState: async () => native } });
  sdk.init.mockImplementationOnce(async () => {
    native.canRequestAds = false;
    return { status: "ready" };
  });
  expect(
    await loadSponsor(["Web development"], new AbortController().signal, dimensions),
  ).toBeNull();
  expect(sdk.init).toHaveBeenCalledOnce();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
});

test.each([
  [" 0 ", "", "allowed"],
  [" 1 ", "consent", "allowed"],
  ["1", "", "unavailable"],
  ["2", "consent", "unavailable"],
])("validates native GDPR applicability %j and TC string %j", async (applies, tc, expected) => {
  const { readSponsorConsent } = await import("../src/ads/consent");
  vi.stubGlobal("admob", {
    privacy: {
      getState: async () => ({
        canRequestAds: true,
        consentStatus: "obtained",
        iabSignals: { IABTCF_gdprApplies: applies, IABTCF_TCString: tc },
      }),
    },
  });
  const result = await readSponsorConsent(new AbortController().signal);
  expect(result.status).toBe(expected);
  if (result.status === "allowed") expect(result.signals[0]).toBe(applies.trim());
});

test("a failed storage restore drops the temporary signal and restores the other keys", async () => {
  const { withSponsorConsent } = await import("../src/ads/consent");
  const tc = "IABTCF_TCString";
  const gpp = "IABGPP_HDR_GppString";
  localStorage.setItem(tc, "previous TC");
  localStorage.setItem(gpp, "previous GPP");
  const write = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === tc && value === "previous TC") throw new Error("Storage quota exceeded");
    write(key, value);
  });
  withSponsorConsent(["1", "native TC", null, "native GPP", null], () => {
    expect(localStorage.getItem(tc)).toBe("native TC");
  });
  expect(localStorage.getItem(tc)).toBeNull();
  expect(localStorage.getItem(gpp)).toBe("previous GPP");
});

test("native consent denial uses one opportunity and backs off after the answer", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  const state = { consentStatus: "required", canRequestAds: false };
  const getState = vi.fn(async () => state);
  vi.stubGlobal("admob", { privacy: { getState } });
  let now = 0;
  const load = vi.fn((topics: string[], signal: AbortSignal) =>
    loadSponsor(topics, signal, dimensions),
  );
  const session = new SponsorSession({
    budget: new SponsorBudget(() => now),
    consent: () => "allowed",
    eligible: () => true,
    visible: () => true,
    load,
  });
  const start = (id: string) => session.update("chat", true, { id, user: "SQL", streaming: true });
  const finish = (id: string) => session.update("chat", false, { id, user: "SQL", answer: "Done" });
  for (const id of ["1", "2"]) {
    start(id);
    finish(id);
  }
  start("3");
  await expect(load.mock.results[0].value).resolves.toBeNull();
  finish("3");
  expect(getState).toHaveBeenCalledOnce();
  Object.assign(state, { consentStatus: "notRequired", canRequestAds: true });
  for (const id of ["4", "5", "6"]) {
    start(id);
    finish(id);
  }
  expect(getState).toHaveBeenCalledOnce();
  expect(sdk.fetchAds).not.toHaveBeenCalled();
  now = 300_000;
  start("7");
  await vi.waitFor(() => expect(sdk.fetchAds).toHaveBeenCalledOnce());
});

test("restores a cleared native override when another key releases storage quota", async () => {
  const { withSponsorConsent } = await import("../src/ads/consent");
  const tc = "IABTCF_TCString";
  const gpp = "IABGPP_HDR_GppString";
  localStorage.setItem(tc, "original");
  const write = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === tc && localStorage.getItem(gpp)) throw Error("Out of quota");
    write(key, value);
  });
  withSponsorConsent([null, null, null, "temporary", null], () => {
    expect(localStorage.getItem(tc)).toBeNull();
  });
  expect(localStorage.getItem(tc)).toBe("original");
  expect(localStorage.getItem(gpp)).toBeNull();
});

test("aborted and timed-out native consent reads never initialize Elo", async () => {
  const getState = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("admob", { privacy: { getState } });
  const { loadSponsor } = await import("../src/ads/elo");
  vi.useFakeTimers();
  const controller = new AbortController();
  const load = () => loadSponsor(["Web development"], controller.signal, dimensions);
  const timedOut = load();
  await vi.runAllTimersAsync();
  expect(await timedOut).toBeNull();
  const aborted = load();
  controller.abort();
  expect(await aborted).toBeNull();
  expect(sdk.init).not.toHaveBeenCalled();
});

test("creates a version 4 UUID with secure random bytes on older WebViews", async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const { loadSponsor } = await import("../src/ads/elo");
  await loadSponsor(["Web development"], new AbortController().signal, dimensions);
  expect(crypto.randomUUID()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(sdk.fetchAds).toHaveBeenCalledOnce();
});

test("backgrounding during initialization cancels the opportunity", async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", doc);
  sdk.init.mockImplementationOnce(async () => {
    doc.hidden = true;
    return { status: "ready" };
  });
  const { loadSponsor } = await import("../src/ads/elo");
  const result = loadSponsor(["Web development"], new AbortController().signal, dimensions);
  expect(await result).toBeNull();
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(sdk.fetchAds).not.toHaveBeenCalled();
});

test.each(["covered", "inactive before switch notification"])(
  "a pending consent read cannot send an ad request when %s",
  async (reason) => {
    const { loadSponsor } = await import("../src/ads/elo");
    let visible = true;
    let finish!: (state: { consentStatus: string; canRequestAds: boolean }) => void;
    const state = { consentStatus: "notRequired", canRequestAds: true };
    const getState = vi
      .fn()
      .mockResolvedValueOnce(state)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal("admob", { privacy: { getState } });
    let signal!: AbortSignal;
    let pending!: ReturnType<typeof loadSponsor>;
    const session = new SponsorSession({
      budget: new SponsorBudget(),
      consent: () => "allowed",
      eligible: () => true,
      visible: () => visible,
      load: (topics, request) => {
        signal = request;
        return (pending = loadSponsor(topics, request, dimensions, () => visible));
      },
    });
    session.update("chat", true, { id: "1", user: "SQL", streaming: true });
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    visible = false;
    if (reason === "covered") {
      session.refresh();
      expect(signal.aborted).toBe(true);
      visible = true;
    }
    finish(state);
    expect(await pending).toBeNull();
    expect(sdk.fetchAds).not.toHaveBeenCalled();
  },
);

test("an aborted opportunity never initializes or requests an ad", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  const controller = new AbortController();
  controller.abort();
  expect(await loadSponsor(["Web development"], controller.signal, dimensions)).toBeNull();
  expect(sdk.init).not.toHaveBeenCalled();
});

test("network failures and unsafe creatives leave the slot empty", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  sdk.fetchAds.mockRejectedValueOnce(new Error("Offline"));
  expect(
    await loadSponsor(["Web development"], new AbortController().signal, dimensions),
  ).toBeNull();
  sdk.fetchAds.mockResolvedValueOnce({ ad: { title: "Unsafe", click_url: "javascript:alert(1)" } });
  expect(
    await loadSponsor(["Web development"], new AbortController().signal, dimensions),
  ).toBeNull();
});

test("accepts Elo tracking paths and HTTPS partner notices and rejects foreign render endpoints", async () => {
  const { loadSponsor } = await import("../src/ads/elo");
  const load = () => loadSponsor(["Web development"], new AbortController().signal, dimensions);
  const ad = {
    title: "Hosting",
    click_url: "https://example.org",
    render_url: "/r",
    impression_url: "https://api.elo.ad/i",
    presentation: { format: "strip", cta_enabled: true, tap_inset: 6 },
    trackers: [
      { event: "click", url: "https://partner.example/notice" },
      { event: "click", url: "http://partner.example/insecure" },
    ],
  };
  sdk.fetchAds.mockResolvedValueOnce({ ad });
  const creative = (await load())?.ad;
  expect(creative?.trackers).toEqual([ad.trackers[0]]);
  expect(creative?.presentation).toEqual({ ...ad.presentation, cta_enabled: false });
  for (const field of ["render_url", "impression_url"]) {
    sdk.fetchAds.mockResolvedValueOnce({ ad: { ...ad, [field]: "https://other.example/r" } });
    expect(await load()).toBeNull();
  }
});
