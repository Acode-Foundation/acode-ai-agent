// @vitest-environment happy-dom
import { h, render } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { loadSponsor, type Sponsor } from "../src/ads/elo";
import * as nativeConsent from "../src/ads/consent";
import { readFileSync } from "node:fs";
import { setSponsorConsent, sponsorConsent } from "../src/ads/preferences";
import { SponsorBudget, type SponsorSession } from "../src/ads/session";
import { openCustomTab } from "../src/platform/authTab";
import { SponsoredCard, SponsorOptIn } from "../src/ui/SponsoredCard";
import { SponsorSettings } from "../src/ui/SponsorSettings";
import { useSponsor } from "../src/ui/useSponsor";
import type { ChatTurn } from "../src/ui/transcript";

vi.mock("../src/platform/authTab", () => ({ openCustomTab: vi.fn(async () => {}) }));
vi.mock("../src/ads/elo", async (load) => ({
  ...(await load<typeof import("../src/ads/elo")>()),
  loadSponsor: vi.fn(),
}));

let root: HTMLElement;
let budget: SponsorBudget;
const ad = {
  title: "Hosting",
  description: "Deploy and monitor a web application from your phone.",
  click_url: "https://example.org",
  cta_text: "Explore",
  presentation: { format: "strip", tap_surface: "cta", cta_enabled: false },
};
const sdk = {
  attachView: () => true,
  canTrack: async () => true,
  trackTap: vi.fn(async () => true),
  trackImpression: vi.fn(async () => true),
  trackRender: vi.fn(async () => true),
  trackClick: vi.fn(),
  hasTrackedImpression: () => false,
};
const sponsor = { ad, sdk, consent: JSON.stringify(Array(5).fill(null)) } as unknown as Sponsor;
beforeEach(() => {
  budget = new SponsorBudget();
  vi.clearAllMocks();
  vi.stubGlobal("admob", {
    privacy: { getState: async () => ({ canRequestAds: true, consentStatus: "notRequired" }) },
  });
  vi.stubGlobal("ANDROID_SDK_INT", 35);
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.stubGlobal("acode", { require: () => ({ HAS_PRO: false }) });
  setSponsorConsent("declined"); // Drop the shared SDK session between integration tests.
  localStorage.clear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(220);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 320,
    height: 72,
    left: 0,
    top: 0,
  } as DOMRect);
  root = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Chat({
  id,
  running,
  covered,
  isTabActive,
  stopped = false,
  error,
  chatId = "chat",
}: {
  id: string;
  running: boolean;
  covered: boolean;
  isTabActive: () => boolean;
  stopped?: boolean;
  error?: string;
  chatId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const turn = {
    id,
    user: "Help deploy",
    answer: running ? undefined : "Done",
    streaming: running,
    stopped,
    error,
  } as ChatTurn;
  const { session, placement, showOptIn, optInRef } = useSponsor(
    ref,
    chatId,
    running,
    turn,
    covered,
    isTabActive,
    budget,
  );
  return h(
    "div",
    null,
    h(
      "main",
      { ref },
      h("section", { class: "turn" }, placement && h(SponsoredCard, { session, placement })),
    ),
    h(
      "div",
      { class: "agent-dock" },
      showOptIn && h(SponsorOptIn, { cardRef: optInRef }),
      h("footer", { class: "composer" }),
    ),
  );
}

test("offers consent during the first visible wait and keeps paid ads on their usual cadence", async () => {
  const switches = new EventTarget();
  vi.stubGlobal("editorManager", {
    on: switches.addEventListener.bind(switches),
    off: switches.removeEventListener.bind(switches),
  });
  let active = true;
  const isTabActive = () => active;
  const switchTab = (toChat: boolean) =>
    act(() => {
      active = toChat;
      switches.dispatchEvent(new Event("switch-file"));
    });
  const draw = (id: string, running = false, covered = false) =>
    act(() => render(h(Chat, { id, running, covered, isTabActive }), root));
  draw("0");
  expect(root.querySelector(".sponsor-consent")).toBeNull();
  draw("1", true, true);
  expect(root.querySelector(".sponsor-consent")).toBeNull();
  vi.stubGlobal("admob", {
    privacy: { getState: async () => ({ canRequestAds: false, consentStatus: "required" }) },
  });
  draw("1", true);
  await act(async () => {});
  expect(root.querySelector(".sponsor-consent")).toBeNull();
  vi.stubGlobal("admob", {
    privacy: { getState: async () => ({ canRequestAds: true, consentStatus: "notRequired" }) },
  });
  document.dispatchEvent(new Event("resume"));
  await vi.waitFor(() => expect(root.querySelector(".sponsor-allow")).toBeTruthy());
  expect(root.querySelector(".sponsor-allow")?.textContent).toBe("Allow Suggestions");
  const privacy = root.querySelector<HTMLButtonElement>(".sponsor-privacy")!;
  const card = root.querySelector(".sponsor-consent")!;
  const originalContents = card.innerHTML;
  expect(privacy.getAttribute("aria-haspopup")).toBe("dialog");
  const body = document.createElement("div");
  const dialogBox = vi.fn((_title: string, html: string) => {
    body.innerHTML = html;
    return {
      onclick: (listener: (event: MouseEvent) => void) => body.addEventListener("click", listener),
    };
  });
  vi.stubGlobal("acode", {
    require: (name: string) => (name === "dialogBox" ? dialogBox : { HAS_PRO: false }),
  });
  act(() => privacy.click());
  expect(dialogBox).toHaveBeenCalledExactlyOnceWith(
    "Sponsored suggestions privacy",
    expect.stringContaining("anonymous identifier"),
    "Done",
    "",
  );
  expect(card.innerHTML).toBe(originalContents);
  expect(root.querySelector("dialog")).toBeNull();
  body.querySelector("p")!.click();
  expect(openCustomTab).not.toHaveBeenCalled();
  const policyLink = body.querySelector("a")!;
  expect(policyLink.textContent).toBe("Acode privacy policy");
  policyLink.click();
  expect(openCustomTab).toHaveBeenCalledWith("https://acode.app/policy");
  vi.mocked(openCustomTab).mockClear();
  expect(sponsorConsent()).toBe("ask");
  expect(loadSponsor).not.toHaveBeenCalled();
  const changeVisibility = (hidden: boolean) =>
    act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
      document.dispatchEvent(new Event("visibilitychange"));
    });
  changeVisibility(true);
  changeVisibility(false);
  await vi.waitFor(() => expect(root.textContent).toContain("Support free Acode"));
  let fill!: (sponsor: Sponsor) => void;
  vi.mocked(loadSponsor).mockReturnValueOnce(
    new Promise((resolve) => {
      fill = resolve;
    }),
  );
  act(() => root.querySelector<HTMLButtonElement>(".sponsor-allow")!.click());
  expect(root.querySelector(".sponsor-consent")).toBeNull();
  expect(loadSponsor).not.toHaveBeenCalled();
  draw("1");
  draw("2", true);
  draw("2");
  expect(loadSponsor).not.toHaveBeenCalled();
  draw("3", true);
  draw("3");
  expect(loadSponsor).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment"],
    expect.any(AbortSignal),
    { maxHeight: 206, maxWidth: 320 },
    expect.any(Function),
  );
  await act(async () => {
    fill(sponsor);
    await Promise.resolve();
  });
  draw("3", false, true);
  expect(root.querySelector(".sponsor-card")).toBeNull();
  draw("3");
  await vi.waitFor(() =>
    expect(root.querySelector(".sponsor-card")?.textContent).toContain("Hosting"),
  );
  changeVisibility(true);
  expect(root.querySelector(".sponsor-card")).toBeNull();
  changeVisibility(false);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card")).toBeTruthy());
  switchTab(false);
  expect(root.querySelector(".sponsor-card")).toBeNull();
  switchTab(true);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
  act(() => setSponsorConsent("declined"));
  expect(root.querySelector(".sponsor-card")).toBeNull();
  expect(loadSponsor).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(300_001);
  setSponsorConsent("allowed");
  vi.mocked(loadSponsor).mockClear().mockResolvedValueOnce(sponsor);
  sdk.trackRender.mockClear();
  for (const id of ["wait-1", "wait-2"]) {
    draw(id, true);
    draw(id, false);
  }
  draw("wait-3", true, true);
  await vi.advanceTimersByTimeAsync(3500);
  expect(loadSponsor).not.toHaveBeenCalled();
  draw("wait-3", true);
  switchTab(false);
  await vi.advanceTimersByTimeAsync(3500);
  expect(loadSponsor).not.toHaveBeenCalled();
  switchTab(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  act(() => setSponsorConsent("declined"));
  await vi.advanceTimersByTimeAsync(3500);
  expect(loadSponsor).not.toHaveBeenCalled();
  act(() => setSponsorConsent("allowed"));
  await vi.advanceTimersByTimeAsync(2999);
  expect(loadSponsor).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(loadSponsor).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment"],
    expect.any(AbortSignal),
    { maxHeight: 72, maxWidth: 320 },
    expect.any(Function),
  );
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
  const link = root.querySelector(".sponsor-card a");
  expect(link?.querySelector(".elo-ad-description")?.textContent).toBe(ad.description);
  draw("wait-3", false);
  expect(root.querySelector(".sponsor-card a")).toBe(link);
  expect(sdk.trackRender).toHaveBeenCalledOnce();
  let opened!: () => void;
  vi.mocked(openCustomTab).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  (link as HTMLAnchorElement).click();
  await vi.waitFor(() => expect(openCustomTab).toHaveBeenCalledOnce());
  changeVisibility(true);
  await act(async () => {
    opened();
  });
  changeVisibility(false);
  document.dispatchEvent(new Event("resume"));
  window.dispatchEvent(new Event("focus"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(root.querySelector(".sponsor-card")).toBeNull();
  expect(loadSponsor).toHaveBeenCalledOnce();
  expect(sdk.trackRender).toHaveBeenCalledOnce();
});

test("the visible opt-in stays above the composer through later replies in its chat", async () => {
  let intersect!: (ratio: number) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
        intersect = (ratio) => callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  const active = () => true;
  const draw = async (id: string, running: boolean, extra = {}) =>
    act(async () =>
      render(h(Chat, { id, running, covered: false, isTabActive: active, ...extra }), root),
    );
  for (const ending of [{ stopped: true }, { error: "Failed" }]) {
    await draw("unseen", true);
    await vi.waitFor(() => expect(root.querySelector(".sponsor-consent")).toBeTruthy());
    intersect(0);
    await draw("unseen", false, ending);
    expect(budget.optInChatId).toBeUndefined();
    expect(root.querySelector(".sponsor-consent")).toBeNull();
  }
  await draw("visible", true);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-consent")).toBeTruthy());
  const card = root.querySelector(".sponsor-consent");
  intersect(1);
  await draw("visible", false, { stopped: true });
  await draw("next", true);
  expect(root.querySelector(".sponsor-consent")).toBe(card);
  expect(card?.nextElementSibling?.matches(".composer")).toBe(true);
  expect(root.querySelector("main .sponsor-consent")).toBeNull();
  await draw("other", true, { chatId: "second-chat" });
  expect(root.querySelector(".sponsor-consent")).toBeNull();
  await draw("next", false);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-consent + .composer")).toBeTruthy());
});

test.each(["missing", "delayed"])(
  "a visible opt-in survives a fast answer with a %s observer",
  async (observer) => {
    vi.stubGlobal(
      "IntersectionObserver",
      observer === "missing"
        ? undefined
        : class {
            observe() {}
            disconnect() {}
          },
    );
    let top = 37; // The editor ends at 72px, so less than half the card fits.
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.matches(".sponsor-consent") ? top : 0, 320, 72);
      },
    );
    const active = () => true;
    const draw = (running: boolean) =>
      act(async () =>
        render(h(Chat, { id: "fast", running, covered: false, isTabActive: active }), root),
      );
    await draw(true);
    await vi.waitFor(() => expect(root.querySelector(".sponsor-consent")).toBeTruthy());
    expect(budget.optInChatId).toBeUndefined();
    await draw(false);
    expect(root.querySelector(".sponsor-consent")).toBeNull();
    top = 36;
    await draw(true);
    await vi.waitFor(() => expect(budget.optInChatId).toBe("chat"));
    await draw(false);
    expect(root.querySelector(".sponsor-consent + .composer")).toBeTruthy();
  },
);

test("device consent gates opt-in, and a prior opt-in can always be withdrawn", async () => {
  let consentStatus = "required";
  const getState = vi.fn(async () => ({ consentStatus, canRequestAds: true }));
  vi.stubGlobal("admob", { privacy: { getState } });
  await act(async () => render(h(SponsorSettings, {}), root));
  expect(getState).toHaveBeenCalled();
  expect(root.querySelector(".sponsor-consent, .sponsor-settings")).toBeNull();
  consentStatus = "NOT_REQUIRED";
  await act(async () => document.dispatchEvent(new Event("resume")));
  await vi.waitFor(() => expect(root.querySelector(".sponsor-settings input")).toBeTruthy());
  act(() => setSponsorConsent("allowed"));
  vi.stubGlobal("admob", undefined);
  act(() => render(h(SponsorSettings, {}), root));
  const toggle = root.querySelector<HTMLInputElement>("input");
  expect(toggle?.checked).toBe(true);
  act(() => toggle?.click());
  expect(sponsorConsent()).toBe("declined");
  expect(loadSponsor).not.toHaveBeenCalled();
});

test("opt-in recovers on focus and stays visible during a coalesced lifecycle recheck", async () => {
  const read = vi
    .spyOn(nativeConsent, "readSponsorConsent")
    .mockRejectedValueOnce(Error("Disconnected"));
  const switches = new EventTarget();
  const off = vi.fn(switches.removeEventListener.bind(switches));
  vi.stubGlobal("editorManager", { on: switches.addEventListener.bind(switches), off });
  await act(async () => render(h(SponsorSettings, {}), root));
  expect(read).toHaveBeenCalledOnce();
  expect(root.querySelector("input")).toBeNull();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(root.querySelector("input")).toBeTruthy());
  const toggle = root.querySelector("input");
  let reject!: (reason: Error) => void;
  read.mockImplementationOnce(() => new Promise((_resolve, fail) => (reject = fail)));
  window.dispatchEvent(new Event("focus"));
  switches.dispatchEvent(new Event("switch-file"));
  document.dispatchEvent(new Event("resume"));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(root.querySelector("input")).toBe(toggle);
  reject(Error("Disconnected"));
  await vi.waitFor(() => expect(root.querySelector("input")).toBeNull());
  act(() => render(null, root));
  expect(off).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  switches.dispatchEvent(new Event("switch-file"));
  expect(read).toHaveBeenCalledTimes(3);
});

test("opens safe links through Acode and reports inert, middle, and repeat taps", async () => {
  setSponsorConsent("allowed");
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = readFileSync("src/ui/styles.css", "utf8");
  onTestFinished(() => style.remove());
  const session = { clear: vi.fn() } as unknown as SponsorSession;
  const draw = (creative: Sponsor) =>
    act(async () =>
      render(
        h(SponsoredCard, {
          session,
          placement: { turnId: "1", context: ["Web development"], sponsor: creative },
        }),
        root,
      ),
    );
  await draw(sponsor);
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  const link = root.querySelector("a")!;
  expect(link.href).toBe("https://example.org/");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
  expect(getComputedStyle(link.querySelector(".elo-ad-chevron")!).display).toBe("none");
  expect(link.querySelector(".elo-ad-title")?.textContent).toContain("Hosting");
  expect(root.querySelector(".elo-ad-cta")).toBeNull();
  expect(link.contains(root.querySelector(".sponsor-dismiss"))).toBe(false);
  const middle = new MouseEvent("auxclick", {
    detail: 1,
    button: 1,
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(middle);
  await Promise.resolve();
  expect(middle.defaultPrevented).toBe(true);
  expect(openCustomTab).toHaveBeenCalledExactlyOnceWith("https://example.org/");
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: true, region: "chrome" }),
  );
  link.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: false, region: "chrome" }),
  );
  const full = {
    ...ad,
    presentation: { ...ad.presentation, format: "card", tap_surface: "full", tap_inset: 8 },
  };
  await draw({ ...sponsor, ad: full } as unknown as Sponsor);
  await vi.waitFor(() => expect(root.querySelector("a")?.style.margin).toBe("8px"));
  expect(root.querySelector(".elo-ad-card a .elo-ad-chevron")).toBeTruthy();
  expect(root.querySelector(".elo-ad-cta")).toBeNull();
  const tapsBeforeDismiss = sdk.trackTap.mock.calls.length;
  root.querySelector<HTMLButtonElement>(".sponsor-dismiss")!.click();
  expect(session.clear).toHaveBeenCalledOnce();
  expect(sdk.trackTap).toHaveBeenCalledTimes(tapsBeforeDismiss);
  expect(root.querySelector("a")!.style.margin).toBe("8px");
  root
    .querySelector<HTMLElement>(".sponsor-card")!
    .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  expect(sdk.trackTap).toHaveBeenLastCalledWith(full, expect.objectContaining({ opened: false }));
  await draw({ ...sponsor, ad: { ...ad, click_url: "javascript:void(0)" } } as unknown as Sponsor);
  expect(root.querySelector("a")).toBeNull();
});

test("SDK dwell requires a continuous visible second and stops on pause or withdrawal", async () => {
  setSponsorConsent("allowed");
  vi.useFakeTimers();
  let intersect!: (ratio: number) => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: object[]) => void) {
        intersect = (intersectionRatio) =>
          callback([{ isIntersecting: intersectionRatio > 0, intersectionRatio }]);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const state = { canRequestAds: true, consentStatus: "notRequired" };
  vi.stubGlobal("admob", { privacy: { getState: async () => state } });
  const clear = vi.fn();
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", context: ["Hosting"], sponsor },
        session: { clear } as unknown as SponsorSession,
      }),
      root,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(sdk.trackRender).toHaveBeenCalledOnce();
  intersect(0.5);
  await vi.advanceTimersByTimeAsync(700);
  intersect(0.49);
  await vi.advanceTimersByTimeAsync(400);
  expect(sdk.trackImpression).not.toHaveBeenCalled();
  intersect(0.5);
  await vi.advanceTimersByTimeAsync(700);
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("resume"));
  await vi.advanceTimersByTimeAsync(300);
  expect(disconnect).not.toHaveBeenCalled();
  expect(sdk.trackImpression).toHaveBeenCalledOnce();
  intersect(0.5);
  document.dispatchEvent(new Event("pause"));
  expect(disconnect).toHaveBeenCalledOnce();
  state.canRequestAds = false;
  document.dispatchEvent(new Event("resume"));
  await vi.advanceTimersByTimeAsync(1100);
  expect(clear).toHaveBeenCalledOnce();
  expect(root.querySelector("a")).toBeNull();
  expect(sdk.trackRender).toHaveBeenCalledOnce();
  expect(sdk.trackImpression).toHaveBeenCalledOnce();
});

test("a failed SDK mount removes the ad without throwing into the chat", async () => {
  setSponsorConsent("allowed");
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor() {
        throw Error("Observer unavailable");
      }
    },
  );
  const clear = vi.fn();
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", context: ["Hosting"], sponsor },
        session: { clear } as unknown as SponsorSession,
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
  expect(root.querySelector(".sponsor-card")?.childElementCount).toBe(0);
});

test("declining suggestions persists the preference and removes advertising identifiers", async () => {
  act(() => render(h(SponsorOptIn, {}), root));
  localStorage.setItem("elo_visitor_id", "test-id");
  document.cookie = "_elo_state=test-id";
  await vi.waitFor(() => expect(root.querySelector(".sponsor-allow")).toBeTruthy());
  act(() =>
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent === "No thanks")!
      .click(),
  );
  expect(sponsorConsent()).toBe("declined");
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  expect(document.cookie).not.toContain("_elo_state=");
});

test("unknown or unavailable native consent preserves identities until consent is required", async () => {
  const { readSponsorConsent } = await import("../src/ads/consent");
  const getState = vi
    .fn()
    .mockResolvedValueOnce({ consentStatus: "unknown", canRequestAds: false })
    .mockRejectedValueOnce(new Error("Bridge offline"))
    // Even a stale canRequestAds flag must not override a required decision.
    .mockResolvedValueOnce({ consentStatus: "required", canRequestAds: true });
  vi.stubGlobal("admob", { privacy: { getState } });
  const signal = new AbortController().signal;
  localStorage.setItem("elo_visitor_id", "fixture");
  document.cookie = "_elo_state=fixture";
  for (const expected of ["unavailable", "unavailable", "denied"]) {
    expect((await readSponsorConsent(signal)).status).toBe(expected);
    expect(localStorage.getItem("elo_visitor_id")).toBe(expected === "denied" ? null : "fixture");
    expect(document.cookie.includes("_elo_state=fixture")).toBe(expected !== "denied");
  }
});

test("the pinned SDK creates no identifier or network request until required CMP signals exist", async () => {
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  const network = vi.fn(async (url: string, options: RequestInit) => {
    if (options.method === "HEAD") return new Response(null, { status: 204 });
    expect(url).toBe("https://api.elo.ad/v1/ad/request");
    const body = JSON.parse(options.body as string);
    expect(body.dimensions).toEqual({ max_height: 150, max_width: 320 });
    expect(body.context).toEqual([{ type: "topic", description: "Web development" }]);
    expect(body.consent.gpp_string).toBe("fixture-gpp");
    expect(body.consent.gpp_sid).toBe("7");
    expect(body.consent.tcf_string).toBe(native.iabSignals.IABTCF_TCString);
    expect(body.messages).toEqual([{ role: "summary", content: "Web development" }]);
    return Response.json({
      request_id: "fixture",
      ad: { ...ad, render_url: "/fixture/render", impression_url: "/fixture/impression" },
    });
  });
  vi.stubGlobal("fetch", network);
  localStorage.setItem("IABTCF_gdprApplies", "1");
  setSponsorConsent("allowed");
  const signal = new AbortController().signal;
  const dimensions = { maxHeight: 150, maxWidth: 320 };
  const native = {
    consentStatus: "obtained",
    canRequestAds: true,
    iabSignals: {
      IABTCF_gdprApplies: 1,
      IABTCF_TCString: "",
      IABGPP_HDR_GppString: "fixture-gpp",
      IABGPP_GppSID: "7",
    },
  };
  vi.stubGlobal("admob", { privacy: { getState: async () => native } });
  expect(await integration.loadSponsor(["Web development"], signal, dimensions)).toBeNull();
  expect(network).not.toHaveBeenCalled();
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  native.iabSignals.IABTCF_TCString = "fixture-consent";
  const result = await integration.loadSponsor(["Web development"], signal, dimensions);
  expect(result?.ad.opportunity_id).toBe("fixture");
  const next = await integration.loadSponsor(["Web development"], signal, dimensions);
  expect(next?.sdk).toBe(result?.sdk);
  expect(network.mock.calls.filter(([, opts]) => opts.method === "HEAD")).toHaveLength(1);
  native.iabSignals.IABTCF_TCString = "updated-consent";
  expect((await integration.loadSponsor(["Web development"], signal, dimensions))?.sdk).not.toBe(
    result?.sdk,
  );
  expect(network.mock.calls.filter(([, opts]) => opts.method === "HEAD")).toHaveLength(2);
  expect(localStorage.getItem("elo_visitor_id")).toBeTruthy();
  setSponsorConsent("declined");
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
});

test("taps open the link and send click notices without scheduling analytics after opt-out", async () => {
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  setSponsorConsent("allowed");
  const network = vi.fn(async (url: string) => {
    if (url.endsWith("/events")) throw Error("offline");
    if (url.endsWith("/request"))
      return Response.json({
        request_id: "tap",
        ad: {
          ...ad,
          render_url: "/r",
          impression_url: "/i",
          trackers: [{ event: "click", url: "https://example.org/click" }],
        },
      });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", network);
  const sponsor = await integration.loadSponsor(["Hosting"], new AbortController().signal, {
    maxHeight: 72,
    maxWidth: 320,
  });
  expect(sponsor).toBeTruthy();
  const session = { clear: vi.fn() } as unknown as SponsorSession;
  act(() =>
    render(
      h(SponsoredCard, {
        session,
        placement: { turnId: "tap", context: ["Hosting"], sponsor: sponsor! },
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  vi.useFakeTimers();
  await act(async () => {
    root
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(openCustomTab).toHaveBeenCalledOnce();
  expect(network.mock.calls.map(([url]) => url)).toContain("https://example.org/click");
  act(() => setSponsorConsent("declined"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(network.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(0);
});

test("a native consent change without a lifecycle event suppresses impression and click notices", async () => {
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  setSponsorConsent("allowed");
  const native = { canRequestAds: true, consentStatus: "notRequired" };
  const getState = vi.fn(async () => native);
  vi.stubGlobal("admob", { privacy: { getState } });
  const network = vi.fn(async (url: string) =>
    url.endsWith("/request")
      ? Response.json({
          request_id: "privacy-change",
          ad: {
            ...ad,
            render_url: "/render",
            impression_url: "/impression",
            trackers: [{ event: "click", url: "https://example.org/notice" }],
          },
        })
      : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", network);
  const result = await integration.loadSponsor(["Web development"], new AbortController().signal, {
    maxHeight: 192,
    maxWidth: 320,
  });
  expect(result).toBeTruthy();
  const { sdk } = result!;
  const clear = vi.fn(() => render(null, root));
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", context: ["Web development"], sponsor: result! },
        session: { clear } as unknown as SponsorSession,
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  const visitor = localStorage.getItem("elo_visitor_id");
  expect(visitor).toBeTruthy();
  native.canRequestAds = false;
  network.mockClear();
  getState.mockClear();
  await act(async () => {
    const impression = sdk.trackImpression(result!.ad);
    root
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
    expect(await impression).toBe(false);
  });
  expect(openCustomTab).not.toHaveBeenCalled();
  expect(root.querySelector("a")).toBeNull();
  expect(getState).toHaveBeenCalledOnce();
  expect(network).not.toHaveBeenCalled();
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  expect(document.cookie).not.toContain("_elo_state=");
  native.canRequestAds = true;
  const next = await integration.loadSponsor(["Web development"], new AbortController().signal, {
    maxHeight: 192,
    maxWidth: 320,
  });
  expect(next?.sdk).toBeTruthy();
  expect(next?.sdk).not.toBe(sdk);
  expect(localStorage.getItem("elo_visitor_id")).not.toBe(visitor);
});

test("the mounted SDK view recovers from an unavailable bridge and cancels a pending click on dismissal", async () => {
  setSponsorConsent("allowed");
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  const state = { canRequestAds: true, consentStatus: "notRequired" };
  const getState = vi.fn(async () => state);
  vi.stubGlobal("admob", { privacy: { getState } });
  const network = vi.fn(async (url: string) =>
    url.endsWith("/request")
      ? Response.json({
          request_id: "dismiss",
          ad: {
            ...ad,
            render_url: "/r",
            impression_url: "/i",
            trackers: [{ event: "click", url: "https://example.org/notice" }],
          },
        })
      : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", network);
  const result = await integration.loadSponsor(["Hosting"], new AbortController().signal, {
    maxHeight: 192,
    maxWidth: 320,
  });
  expect(result).toBeTruthy();
  const clear = vi.fn(() => render(null, root));
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", context: ["Hosting"], sponsor: result! },
        session: { clear } as unknown as SponsorSession,
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  const visitor = localStorage.getItem("elo_visitor_id");
  expect(visitor).toBeTruthy();
  // A host accessor can throw before the native getState promise even exists.
  vi.stubGlobal("admob", {
    get privacy() {
      throw new Error("Host unavailable");
    },
  });
  await expect(result!.sdk.trackImpression(result!.ad)).resolves.toBe(false);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(root.querySelector("a")).toBeNull());
  expect(clear).not.toHaveBeenCalled();
  expect(localStorage.getItem("elo_visitor_id")).toBe(visitor);
  vi.stubGlobal("admob", { privacy: { getState } });
  document.dispatchEvent(new Event("resume"));
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  let finish!: (value: typeof state) => void;
  getState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  getState.mockClear();
  network.mockClear();
  document.dispatchEvent(new Event("resume"));
  expect(getState).toHaveBeenCalledOnce();
  root
    .querySelector("a")!
    .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  expect(getState).toHaveBeenCalledOnce();
  act(() => root.querySelector<HTMLButtonElement>(".sponsor-dismiss")!.click());
  await act(async () => {
    finish(state);
  });
  expect(openCustomTab).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

test("a failed consent check on opening allows the user to retry and removes a replaced session", async () => {
  setSponsorConsent("allowed");
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  const consent = {
    canRequestAds: true,
    consentStatus: "obtained",
    iabSignals: { IABTCF_gdprApplies: "1", IABTCF_TCString: "original" },
  };
  const getState = vi.fn(async () => consent);
  vi.stubGlobal("admob", { privacy: { getState } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/request")
        ? Response.json({
            request_id: "retry",
            ad: { ...ad, render_url: "/r", impression_url: "/i" },
          })
        : new Response(null, { status: 204 }),
    ),
  );
  const load = () =>
    integration.loadSponsor(["Hosting"], new AbortController().signal, {
      maxHeight: 192,
      maxWidth: 320,
    });
  const original = await load();
  expect(original).toBeTruthy();
  const clear = vi.fn(() => render(null, root));
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", context: ["Hosting"], sponsor: original! },
        session: { clear } as unknown as SponsorSession,
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  const firstLink = root.querySelector("a")!;
  getState.mockRejectedValueOnce(new Error("Temporarily unavailable"));
  await act(async () => firstLink.click());
  expect(openCustomTab).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(root.querySelector("a")).toBeTruthy();
    expect(root.querySelector("a")).not.toBe(firstLink);
  });
  root.querySelector("a")!.click();
  await vi.waitFor(() =>
    expect(openCustomTab).toHaveBeenCalledExactlyOnceWith("https://example.org/"),
  );

  consent.iabSignals.IABTCF_TCString = "changed";
  expect(await load()).toBeTruthy();
  consent.iabSignals.IABTCF_TCString = "original";
  const latest = await load();
  expect(latest?.sdk).toBeTruthy();
  expect(latest?.sdk).not.toBe(original!.sdk);
  await act(async () => {
    document.dispatchEvent(new Event("resume"));
  });
  await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
  expect(root.querySelector("a")).toBeNull();
});

test("a legacy native CMP cannot authorize an obtained decision with a stale WebView string", async () => {
  const { readSponsorConsent } = await import("../src/ads/consent");
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  localStorage.setItem("IABTCF_gdprApplies", "1");
  localStorage.setItem("IABTCF_TCString", "old-consent");
  localStorage.setItem("IABGPP_HDR_GppString", "old-gpp");
  const state = { canRequestAds: true, consentStatus: "obtained" };
  vi.stubGlobal("admob", { privacy: { getState: async () => state } });
  const signal = new AbortController().signal;
  expect((await readSponsorConsent(signal)).status).toBe("unavailable");
  state.consentStatus = "notRequired";
  setSponsorConsent("allowed");
  const network = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === "HEAD") return new Response(null, { status: 204 });
    const consent = JSON.parse(String(options.body)).consent;
    expect(consent).toMatchObject({ gdpr_applies: null, tcf_string: null, gpp_string: null });
    return Response.json({
      request_id: "legacy",
      ad: { ...ad, render_url: "/r", impression_url: "/i" },
    });
  });
  vi.stubGlobal("fetch", network);
  expect(
    await integration.loadSponsor(["Web development"], signal, { maxHeight: 150, maxWidth: 320 }),
  ).toBeTruthy();
  expect(network.mock.calls.filter(([, opts]) => opts.method === "HEAD")).toHaveLength(1);
  expect(localStorage.getItem("IABTCF_TCString")).toBe("old-consent");
  expect(localStorage.getItem("IABGPP_HDR_GppString")).toBe("old-gpp");
  state.canRequestAds = false;
  expect((await readSponsorConsent(signal)).status).toBe("denied");
});
