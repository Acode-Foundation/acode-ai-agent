// @vitest-environment happy-dom
import { h, render } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadSponsor, type Sponsor } from "../src/ads/elo";
import { setSponsorConsent, sponsorConsent } from "../src/ads/preferences";
import type { SponsorSession } from "../src/ads/session";
import { openCustomTab } from "../src/platform/authTab";
import { SponsoredCard } from "../src/ui/SponsoredCard";
import { useSponsor } from "../src/ui/useSponsor";
import type { ChatTurn } from "../src/ui/transcript";

vi.mock("../src/platform/authTab", () => ({ openCustomTab: vi.fn(async () => {}) }));
vi.mock("../src/ads/elo", async (load) => ({
  ...(await load<typeof import("../src/ads/elo")>()),
  loadSponsor: vi.fn(),
}));

let root: HTMLElement;
const ad = {
  title: "Hosting",
  click_url: "https://example.org",
  cta_text: "Explore",
  presentation: { format: "strip", tap_surface: "cta" },
};
const sdk = {
  trackTap: vi.fn(async () => true),
  trackRender: vi.fn(async () => true),
  hasTrackedImpression: () => false,
};
const sponsor = { ad, sdk } as unknown as Sponsor;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("cordova", { platformId: "android" });
  vi.stubGlobal("acode", { require: () => ({ HAS_PRO: false }) });
  localStorage.clear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as DOMRectList);
  root = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Chat({ id, running, covered }: { id: string; running: boolean; covered: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const turn = { id, user: "Help deploy", answer: "Done" } as ChatTurn;
  const { session, placement } = useSponsor(ref, "chat", running, turn, covered);
  return h("div", { ref }, placement && h(SponsoredCard, { session, placement }));
}

test("keeps the third-turn prompt and a pending creative across Settings and backgrounding", async () => {
  const draw = (id: string, running = false, covered = false) =>
    act(() => render(h(Chat, { id, running, covered }), root));
  draw("0");
  for (const id of ["1", "2", "3"]) {
    draw(id, true);
    draw(id);
  }
  expect(root.textContent).toContain("Support free Acode");
  draw("3", false, true);
  expect(root.textContent).toBe("");
  draw("3");
  expect(root.textContent).toContain("Allow suggestions");
  const changeVisibility = (hidden: boolean) =>
    act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
      document.dispatchEvent(new Event("visibilitychange"));
    });
  changeVisibility(true);
  changeVisibility(false);
  expect(root.textContent).toContain("Support free Acode");
  let fill!: (sponsor: Sponsor) => void;
  vi.mocked(loadSponsor).mockReturnValueOnce(
    new Promise((resolve) => {
      fill = resolve;
    }),
  );
  act(() => root.querySelector<HTMLButtonElement>(".sponsor-allow")!.click());
  expect(loadSponsor).toHaveBeenCalledOnce();
  draw("3", false, true);
  await act(async () => {
    fill(sponsor);
    await Promise.resolve();
  });
  expect(root.querySelector(".sponsor-card")).toBeNull();
  draw("3");
  expect(root.querySelector(".sponsor-card")?.textContent).toContain("Hosting");
  changeVisibility(true);
  expect(root.querySelector(".sponsor-card")).toBeNull();
  changeVisibility(false);
  expect(root.querySelector(".sponsor-card")).toBeTruthy();
  act(() => setSponsorConsent("declined"));
  expect(root.querySelector(".sponsor-card")).toBeNull();
  expect(loadSponsor).toHaveBeenCalledOnce();
});

test("opens safe links through Acode and reports inert, middle, and repeat taps", async () => {
  setSponsorConsent("allowed");
  const session = { clear: vi.fn() } as unknown as SponsorSession;
  const draw = (creative: Sponsor) =>
    act(() =>
      render(
        h(SponsoredCard, {
          session,
          placement: { turnId: "1", context: "Web development", sponsor: creative },
        }),
        root,
      ),
    );
  draw(sponsor);
  const link = root.querySelector("a")!;
  expect(link.href).toBe("https://example.org/");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
  root.querySelector<HTMLElement>("[data-ad-region=headline]")!.click();
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: false, region: "headline" }),
  );
  const middle = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
  link.dispatchEvent(middle);
  await Promise.resolve();
  expect(middle.defaultPrevented).toBe(true);
  expect(openCustomTab).toHaveBeenCalledExactlyOnceWith("https://example.org/");
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: true, region: "cta" }),
  );
  link.click();
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: false, region: "cta" }),
  );
  const full = { ...ad, presentation: { tap_surface: "full", tap_inset: 8 } };
  draw({ sdk, ad: full } as unknown as Sponsor);
  expect(root.querySelector("a")!.style.margin).toBe("8px");
  root.querySelector<HTMLElement>(".sponsor-card")!.click();
  expect(sdk.trackTap).toHaveBeenLastCalledWith(full, expect.objectContaining({ opened: false }));
  draw({ sdk, ad: { ...ad, click_url: "javascript:void(0)" } } as unknown as Sponsor);
  expect(root.querySelector("a")).toBeNull();
});

test("declining suggestions persists the preference and removes advertising identifiers", () => {
  const session = { clear: vi.fn() } as unknown as SponsorSession;
  act(() =>
    render(
      h(SponsoredCard, { session, placement: { turnId: "1", context: "Web development" } }),
      root,
    ),
  );
  localStorage.setItem("elo_visitor_id", "test-id");
  document.cookie = "_elo_state=test-id";
  act(() =>
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent === "No thanks")!
      .click(),
  );
  expect(sponsorConsent()).toBe("declined");
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  expect(document.cookie).not.toContain("_elo_state=");
});

test("the pinned SDK creates no identifier or network request until required CMP signals exist", async () => {
  const integration = await vi.importActual<typeof import("../src/ads/elo")>("../src/ads/elo");
  const network = vi.fn(async (url: string, options: RequestInit) => {
    if (options.method === "HEAD") return new Response(null, { status: 204 });
    expect(url).toBe("https://api.elo.ad/v1/ad/request");
    expect(JSON.parse(options.body as string).messages).toEqual([
      { role: "summary", content: "Web development" },
    ]);
    return Response.json({
      request_id: "fixture",
      ad: { ...ad, render_url: "/fixture/render", impression_url: "/fixture/impression" },
    });
  });
  vi.stubGlobal("fetch", network);
  localStorage.setItem("IABTCF_gdprApplies", "1");
  setSponsorConsent("allowed");
  const signal = new AbortController().signal;
  expect(await integration.loadSponsor("Web development", signal)).toBeNull();
  expect(network).not.toHaveBeenCalled();
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  localStorage.setItem("IABTCF_TCString", "fixture-consent");
  const result = await integration.loadSponsor("Web development", signal);
  expect(result?.ad.opportunity_id).toBe("fixture");
  expect(network).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem("elo_visitor_id")).toBeTruthy();
  setSponsorConsent("declined");
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
});
