// @vitest-environment happy-dom
import { createRef, h, render } from "preact";
import Cookies from "js-cookie";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { loadSponsor, type Sponsor } from "../src/suggestions/elo";
import * as nativeConsent from "../src/suggestions/consent";
import { readFileSync } from "node:fs";
import {
  setSponsorConsent,
  sponsorConsent,
  sponsorPreferencesChanged,
  clearSponsorIdentity,
  sponsorIdentityCleared,
} from "../src/suggestions/preferences";
import { SponsorBudget } from "../src/suggestions/session";
import { openCustomTab } from "../src/platform/authTab";
import { showToast } from "../src/platform/toast";
import { SponsoredCard, SponsorOptIn } from "../src/ui/SponsoredCard";
import { SponsorSettings } from "../src/ui/SponsorSettings";
import { useSponsor } from "../src/ui/useSponsor";
import type { ChatTurn } from "../src/ui/transcript";

vi.mock("../src/platform/toast", () => ({ showToast: vi.fn() }));
vi.mock("../src/platform/authTab", () => ({ openCustomTab: vi.fn(async () => {}) }));
vi.mock("../src/suggestions/elo", async (load) => ({
  ...(await load<typeof import("../src/suggestions/elo")>()),
  loadSponsor: vi.fn(),
}));

let root: HTMLElement;
let budget: SponsorBudget;
// Native preference-file behavior is covered in androidConsent.test.ts.
vi.mock("../src/suggestions/androidConsent", async (load) => ({
  ...(await load<typeof import("../src/suggestions/androidConsent")>()),
  readAndroidConsentSignals: async () => undefined,
}));

const ad = {
  title: "Hosting",
  description: "Deploy and monitor a web application from your phone.",
  click_url: "https://example.org",
  cta_text: "Explore",
  presentation: { format: "strip", tap_surface: "cta", cta_enabled: false },
};
const sdk = {
  attachView: (_ad: unknown, _signal: AbortSignal) => true,
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
  onTestFinished(sponsorPreferencesChanged.subscribe((value) => budget.consentChanged(value)));
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
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
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
  answered = false,
  composing = false,
  error,
  chatId = "chat",
  previous = [],
}: {
  id: string;
  running: boolean;
  covered: boolean;
  isTabActive: () => boolean;
  stopped?: boolean;
  answered?: boolean;
  composing?: boolean;
  error?: string;
  chatId?: string;
  previous?: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const turn = {
    id,
    user: "Help deploy",
    answer: running && !answered ? undefined : "Done",
    streaming: running,
    stopped,
    error,
  } as ChatTurn;
  const { placement, showOptIn, optInRef } = useSponsor(
    ref,
    chatId,
    running,
    [...previous.map((user, index) => ({ id: `history-${index}`, user }) as ChatTurn), turn],
    covered,
    isTabActive,
    budget,
    composing,
  );
  return h(
    "div",
    null,
    h(
      "main",
      { ref },
      ...[...previous, id].map((key) => h("section", { class: "turn", key, "data-id": key })),
    ),
    h(
      "div",
      { class: "agent-dock" },
      placement && h(SponsoredCard, { budget, placement }),
      showOptIn && h(SponsorOptIn, { cardRef: optInRef }),
      h("footer", { class: "composer" }, h("div", { class: "composer-dock" })),
    ),
  );
}

test("offers consent during the first wait and docks the suggestion above the input", async () => {
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
  const draw = (
    id: string,
    running = false,
    covered = false,
    previous: string[] = [],
    chatId = "chat",
  ) => act(() => render(h(Chat, { id, running, covered, isTabActive, previous, chatId }), root));
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
  expect(loadSponsor).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment"],
    expect.any(AbortSignal),
    { maxHeight: 72, maxWidth: 320 },
    expect.any(Function),
    expect.any(Function),
  );
  await act(async () => {
    fill(sponsor);
  });
  await vi.waitFor(() =>
    expect(root.querySelector(".agent-dock > .sponsor .sponsor-card a")).toBeTruthy(),
  );
  expect(root.querySelector(".sponsor")?.nextElementSibling?.className).toBe("composer");
  expect(root.querySelector(".turn .sponsor")).toBeNull();
  changeVisibility(true);
  expect(root.querySelector(".sponsor-card")).toBeNull();
  changeVisibility(false);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
  switchTab(false);
  expect(root.querySelector(".sponsor-card")).toBeNull();
  switchTab(true);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
  const link = root.querySelector(".sponsor-card a");
  expect(link?.querySelector(".elo-ad-description")?.textContent).toBe(ad.description);
  vi.useFakeTimers();
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
});

test.each(["streaming answer", "finished", "typing", "stopped", "failed"])(
  "the retained card handles %s without another request",
  async (state) => {
    setSponsorConsent("allowed");
    vi.mocked(loadSponsor).mockResolvedValue(sponsor);
    const active = () => true;
    const draw = (extra = {}) =>
      act(async () =>
        render(
          h(Chat, {
            id: "first",
            running: true,
            covered: false,
            isTabActive: active,
            ...extra,
          }),
          root,
        ),
      );
    await draw();
    await vi.waitFor(() => expect(root.querySelector(".agent-dock .sponsor a")).toBeTruthy());
    const extra =
      state === "streaming answer"
        ? { answered: true }
        : state === "finished"
          ? { running: false }
          : state === "typing"
            ? { composing: true }
            : state === "stopped"
              ? { stopped: true }
              : { error: "Failed" };
    await draw(extra);
    const staysVisible = state === "streaming answer" || state === "finished";
    expect(Boolean(root.querySelector(".agent-dock .sponsor"))).toBe(staysVisible);
    document.dispatchEvent(new Event("resume"));
    await act(async () => {});
    expect(Boolean(root.querySelector(".agent-dock .sponsor"))).toBe(staysVisible);
    if (state === "typing") {
      await draw({ running: false, composing: false });
      await vi.waitFor(() => expect(root.querySelector(".agent-dock .sponsor a")).toBeTruthy());
    }
    expect(root.querySelector(".turn .sponsor")).toBeNull();
    expect(loadSponsor).toHaveBeenCalledOnce();
  },
);

test("reuses one cached ad across waits until the user dismisses it", async () => {
  setSponsorConsent("allowed");
  vi.mocked(loadSponsor).mockResolvedValue(sponsor);
  const active = () => true;
  const draw = (id: string, running: boolean) =>
    act(async () =>
      render(
        h(Chat, {
          id,
          running,
          covered: false,
          isTabActive: active,
          previous: ["SQL database with private credentials"],
        }),
        root,
      ),
    );
  await draw("first", true);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
  const cached = budget.card("chat");
  expect(loadSponsor).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment", "Databases and data storage"],
    expect.any(AbortSignal),
    { maxHeight: 72, maxWidth: 320 },
    expect.any(Function),
    expect.any(Function),
  );
  expect(root.querySelector(".sponsor-thumbnail")).toBeTruthy();
  await draw("first", false);
  expect(root.querySelector(".agent-dock > .sponsor")).toBeTruthy();
  await draw("second", true);
  await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
  expect(budget.card("chat")).toBe(cached);
  expect(vi.mocked(loadSponsor).mock.calls.filter((call) => call[2].maxHeight === 72)).toHaveLength(
    1,
  );
  act(() => root.querySelector<HTMLButtonElement>(".agent-dock .sponsor-dismiss")!.click());
  expect(root.querySelector(".agent-dock > .sponsor")).toBeNull();
  expect(budget.card("chat")).toBeUndefined();
  await draw("third", true);
  expect(root.querySelector(".agent-dock > .sponsor")).toBeNull();
  expect(vi.mocked(loadSponsor).mock.calls.filter((call) => call[2].maxHeight === 72)).toHaveLength(
    1,
  );
});

test("fast replies display the same compact ad when its pending request finishes", async () => {
  setSponsorConsent("allowed");
  vi.useFakeTimers();
  let fill!: (value: Sponsor) => void;
  vi.mocked(loadSponsor).mockReturnValueOnce(
    new Promise((resolve) => {
      fill = resolve;
    }),
  );
  const active = () => true;
  const draw = (running: boolean) =>
    act(async () =>
      render(
        h(Chat, {
          id: "fast",
          running,
          covered: false,
          isTabActive: active,
        }),
        root,
      ),
    );
  await draw(true);
  await draw(false);
  expect(root.querySelector(".sponsor")).toBeNull();
  await act(async () => {
    fill(sponsor);
  });
  await vi.waitFor(() => expect(root.querySelector(".agent-dock .elo-ad-strip a")).toBeTruthy());
  expect(root.querySelector(".turn .sponsor")).toBeNull();
  expect(loadSponsor).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300_000);
  });
  expect(root.querySelector(".sponsor")).toBeNull();
  expect(loadSponsor).toHaveBeenCalledOnce();
});

test("an ad that finishes after the chat tab loses focus appears when it returns", async () => {
  setSponsorConsent("allowed");
  let active = true;
  const isTabActive = () => active;
  let fill!: (value: Sponsor) => void;
  vi.mocked(loadSponsor).mockReturnValueOnce(
    new Promise((resolve) => {
      fill = resolve;
    }),
  );
  const switches = new EventTarget();
  vi.stubGlobal("editorManager", {
    on: switches.addEventListener.bind(switches),
    off: switches.removeEventListener.bind(switches),
  });
  const switchTab = (value: boolean) =>
    act(() => {
      active = value;
      switches.dispatchEvent(new Event("switch-file"));
    });
  await act(async () =>
    render(h(Chat, { id: "live", running: true, covered: false, isTabActive }), root),
  );
  await vi.waitFor(() => expect(loadSponsor).toHaveBeenCalledOnce());
  switchTab(false);
  expect(root.querySelector(".agent-dock > .sponsor")).toBeNull();
  await act(async () => fill(sponsor));
  expect(root.querySelector(".agent-dock > .sponsor")).toBeNull();
  switchTab(true);
  await vi.waitFor(() => expect(root.querySelector(".agent-dock .sponsor a")).toBeTruthy());
  expect(budget.card("chat")?.sponsor).toBe(sponsor);
});

test("the composer reports draft presence for text and attachment-only drafts", async () => {
  const { Composer } = await import("../src/ui/Composer");
  const ref = createRef<import("../src/ui/Composer").ComposerHandle>();
  const changed = vi.fn();
  act(() =>
    render(
      h(Composer, {
        ref,
        controller: {} as import("../src/app/agentController").AgentController,
        running: false,
        disabled: false,
        permissionMode: "ask",
        effort: "off",
        effortLevels: [],
        modelName: "Model",
        acceptsImages: false,
        commands: [],
        autocompleteMaxVisible: 5,
        onOpenConfig: () => {},
        usage: { tokens: 0, cost: 0 },
        contextTokens: 0,
        queued: [],
        onFocusComposer: () => {},
        onDraftChange: changed,
        onSubmit: async () => {},
        onStop: () => {},
        onToast: () => {},
        onPreviewAttachment: () => {},
      }),
      root,
    ),
  );
  expect(changed).toHaveBeenLastCalledWith(false);
  const input = root.querySelector<HTMLElement>('[role="textbox"]')!;
  act(() => {
    input.textContent = "A follow-up";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(changed).toHaveBeenLastCalledWith(true);
  act(() => {
    input.textContent = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(changed).toHaveBeenLastCalledWith(false);
  act(() => ref.current!.setText("Restored draft"));
  expect(changed).toHaveBeenLastCalledWith(true);
  for (const attachment of [
    {
      images: [
        {
          type: "image" as const,
          id: "image",
          name: "test.png",
          mimeType: "image/png",
          data: "AA==",
        },
      ],
      files: [],
    },
    {
      images: [],
      files: [{ id: "file", name: "test.txt", content: "hello", encoding: "text" as const }],
    },
  ]) {
    act(() => ref.current!.setText(""));
    expect(changed).toHaveBeenLastCalledWith(false);
    act(() => ref.current!.restore({ text: "", ...attachment }));
    expect(changed).toHaveBeenLastCalledWith(true);
  }
});

test.each(["pro", "bridge"])(
  "a rerender hides a cached card after a silent %s change",
  async (change) => {
    setSponsorConsent("allowed");
    vi.mocked(loadSponsor).mockResolvedValue(sponsor);
    const active = () => true;
    const draw = () =>
      act(async () =>
        render(h(Chat, { id: "live", running: true, covered: false, isTabActive: active }), root),
      );
    await draw();
    await vi.waitFor(() => expect(root.querySelector(".sponsor a")).toBeTruthy());
    if (change === "pro") vi.stubGlobal("acode", { require: () => ({ HAS_PRO: true }) });
    else vi.stubGlobal("admob", undefined);
    await draw();
    expect(root.querySelector(".sponsor")).toBeNull();
  },
);

test("the thumbnail fallback follows missing and failed SDK images", async () => {
  setSponsorConsent("allowed");
  const draw = (image_url?: string) =>
    act(async () =>
      render(
        h(SponsoredCard, {
          budget,
          placement: {
            chatId: "chat",
            turnId: "image",
            sponsor: { ...sponsor, ad: { ...sponsor.ad, image_url } },
          },
        }),
        root,
      ),
    );
  await draw();
  await vi.waitFor(() => expect(root.querySelector(".sponsor-no-image")).toBeTruthy());
  await draw("https://example.org/logo.png");
  await vi.waitFor(() => expect(root.querySelector(".elo-ad-image")).toBeTruthy());
  expect(root.querySelector(".sponsor-no-image")).toBeNull();
  root.querySelector(".elo-ad-image")!.dispatchEvent(new Event("error"));
  expect(root.querySelector(".elo-ad-image")).toBeNull();
  expect(root.querySelector(".sponsor-no-image")).toBeTruthy();
});

async function mountImageCard() {
  setSponsorConsent("allowed");
  await act(async () =>
    render(
      h(SponsoredCard, {
        budget,
        placement: {
          chatId: "chat",
          turnId: "image-retry",
          sponsor: { ...sponsor, ad: { ...sponsor.ad, image_url: "https://example.org/logo.png" } },
        },
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(root.querySelector(".elo-ad-image")).toBeTruthy());
  const image = root.querySelector<HTMLImageElement>(".elo-ad-image");
  if (!image) throw new Error("Expected the SDK thumbnail");
  return image;
}

test("a failed thumbnail retries once and recovers without remounting the ad", async () => {
  const image = await mountImageCard();
  const parent = image.parentElement;
  const next = image.nextSibling;
  const consent = vi.spyOn(sdk, "canTrack");
  const link = root.querySelector(".sponsor a");
  const renders = sdk.trackRender.mock.calls.length;
  const source = vi.spyOn(image, "src", "set");
  vi.useFakeTimers();
  image.dispatchEvent(new Event("error"));
  expect(root.querySelector(".sponsor-no-image")).toBeTruthy();
  await vi.advanceTimersByTimeAsync(1000);
  expect(source).toHaveBeenCalledExactlyOnceWith("https://example.org/logo.png");
  expect(root.querySelector(".sponsor-no-image")).toBeTruthy();
  image.dispatchEvent(new Event("load"));
  expect(root.querySelector(".elo-ad-image")).toBe(image);
  expect(image.parentElement).toBe(parent);
  expect(image.nextSibling).toBe(next);
  expect(root.querySelector(".sponsor-no-image")).toBeNull();
  expect(root.querySelector(".sponsor a")).toBe(link);
  expect(sdk.trackRender).toHaveBeenCalledTimes(renders);
  image.dispatchEvent(new Event("error"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(source).toHaveBeenCalledTimes(1);
  expect(consent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ image_url: image.src }),
  );
  expect(root.querySelector(".sponsor-no-image")).toBeTruthy();
});

test("thumbnail recovery tolerates a removed insertion sibling", async () => {
  const image = await mountImageCard();
  const parent = image.parentElement;
  const next = image.nextSibling;
  if (!parent || !next) throw new Error("Expected the SDK image and content siblings");
  vi.useFakeTimers();
  image.dispatchEvent(new Event("error"));
  parent.removeChild(next);
  await vi.advanceTimersByTimeAsync(1000);
  image.dispatchEvent(new Event("load"));
  expect(parent.lastChild).toBe(image);
  expect(root.querySelector(".sponsor-no-image")).toBeNull();
});

test("a replacement view can retry without reviving the previous thumbnail", async () => {
  const previous = await mountImageCard();
  const previousSource = vi.spyOn(previous, "src", "set");
  vi.useFakeTimers();
  previous.dispatchEvent(new Event("error"));
  await act(() => render(null, root));
  const image = await mountImageCard();
  const source = vi.spyOn(image, "src", "set");
  image.dispatchEvent(new Event("error"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(previousSource).not.toHaveBeenCalled();
  expect(source).toHaveBeenCalledTimes(1);
  previous.dispatchEvent(new Event("load"));
  expect(previous.isConnected).toBe(false);
  image.dispatchEvent(new Event("load"));
  expect(root.querySelector(".elo-ad-image")).toBe(image);
  image.dispatchEvent(new Event("error"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(source).toHaveBeenCalledTimes(1);
});

test.each(["pause", "withdraw", "unmount"])(
  "%s cancels a pending thumbnail retry",
  async (change) => {
    const image = await mountImageCard();
    const source = vi.spyOn(image, "src", "set");
    vi.useFakeTimers();
    image.dispatchEvent(new Event("error"));
    await act(() => {
      if (change === "pause") document.dispatchEvent(new Event("pause"));
      else if (change === "withdraw") setSponsorConsent("declined");
      else render(null, root);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(source).not.toHaveBeenCalled();
    image.dispatchEvent(new Event("load"));
    expect(root.querySelector(".elo-ad-image")).toBeNull();
  },
);

test.each(["denied", "rejected", "stale"])("thumbnail retry handles %s consent", async (result) => {
  const image = await mountImageCard();
  const source = vi.spyOn(image, "src", "set");
  let resolve: (allowed: boolean) => void = () => {};
  vi.spyOn(sdk, "canTrack").mockImplementation(() =>
    result === "rejected"
      ? Promise.reject(new Error("bridge unavailable"))
      : new Promise<boolean>((done) => {
          resolve = done;
        }),
  );
  vi.useFakeTimers();
  image.dispatchEvent(new Event("error"));
  await vi.advanceTimersByTimeAsync(1000);
  if (result === "stale") document.dispatchEvent(new Event("pause"));
  resolve(result === "stale");
  await vi.advanceTimersByTimeAsync(1000);
  expect(source).not.toHaveBeenCalled();
  expect(root.querySelector(".elo-ad-image")).toBeNull();
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
  await act(async () => {
    document.dispatchEvent(new Event("resume"));
  });
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
  const dismiss = vi.spyOn(budget, "dismiss");
  const draw = (creative: Sponsor) =>
    act(async () =>
      render(
        h(SponsoredCard, {
          budget,
          placement: { turnId: "1", chatId: "chat", sponsor: creative },
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
  const title = link.querySelector(".elo-ad-title");
  const disclosure = root.querySelector(".sponsor-label .elo-ad-sponsored");
  expect(title?.textContent).toBe("Hosting");
  expect(disclosure?.textContent).toBe("Sponsored · Elo");
  expect(link.contains(disclosure)).toBe(false);
  expect(root.querySelectorAll(".elo-ad-sponsored")).toHaveLength(1);
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
  await vi.waitFor(() =>
    expect(openCustomTab).toHaveBeenCalledExactlyOnceWith("https://example.org/"),
  );
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: true, region: "chrome" }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  link.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    ad,
    expect.objectContaining({ opened: false, region: "chrome" }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const full = {
    ...ad,
    presentation: { ...ad.presentation, format: "card", tap_surface: "full", tap_inset: 8 },
  };
  await draw({ ...sponsor, ad: full } as unknown as Sponsor);
  await vi.waitFor(() => expect(root.querySelector("a")?.style.margin).toBe("8px"));
  expect(root.querySelector(".elo-ad-card a .elo-ad-chevron")).toBeTruthy();
  expect(root.querySelector(".elo-ad-cta")).toBeNull();
  dismiss.mockClear();
  const tapsBeforeDismiss = sdk.trackTap.mock.calls.length;
  root.querySelector<HTMLButtonElement>(".sponsor-dismiss")!.click();
  expect(dismiss).toHaveBeenCalledOnce();
  expect(sdk.trackTap).toHaveBeenCalledTimes(tapsBeforeDismiss);
  expect(root.querySelector("a")!.style.margin).toBe("8px");
  root
    .querySelector<HTMLElement>(".sponsor-card")!
    .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
  expect(sdk.trackTap).toHaveBeenLastCalledWith(
    full,
    expect.objectContaining({ opened: false }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
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
  const clear = vi.spyOn(budget, "dismiss");
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", chatId: "chat", sponsor },
        budget,
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

test("an unavailable consent read at mount retries and still renders the ad", async () => {
  setSponsorConsent("allowed");
  vi.useFakeTimers();
  const getState = vi
    .fn()
    .mockRejectedValueOnce(new Error("Bridge busy"))
    .mockResolvedValue({ canRequestAds: true, consentStatus: "notRequired" });
  vi.stubGlobal("admob", { privacy: { getState } });
  act(() =>
    render(
      h(SponsoredCard, {
        budget,
        placement: { turnId: "retry", chatId: "chat", sponsor },
      }),
      root,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(sdk.trackRender).not.toHaveBeenCalled();
  expect(root.querySelector(".sponsor a")).toBeNull();
  await vi.advanceTimersByTimeAsync(500);
  expect(sdk.trackRender).toHaveBeenCalledOnce();
  expect(root.querySelector(".sponsor a")).toBeTruthy();
});

test("a consent timeout at mount is not retried", async () => {
  setSponsorConsent("allowed");
  vi.useFakeTimers();
  const read = vi
    .spyOn(nativeConsent, "readSponsorConsent")
    .mockResolvedValueOnce({ status: "unavailable", reason: "timeout" } as never);
  act(() =>
    render(
      h(SponsoredCard, {
        budget,
        placement: { turnId: "timeout", chatId: "chat", sponsor },
      }),
      root,
    ),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledOnce();
  expect(sdk.trackRender).not.toHaveBeenCalled();
  expect(root.querySelector(".sponsor a")).toBeNull();
});

test.each([
  ["focus", "bridge"],
  ["focus", "invalid"],
  ["resume", "bridge"],
  ["resume", "invalid"],
] as const)("a mounted card stops immediately on %s when consent is %s", async (event, reason) => {
  setSponsorConsent("allowed");
  vi.useFakeTimers();
  const read = vi.spyOn(nativeConsent, "readSponsorConsent");
  const dismiss = vi.spyOn(budget, "dismiss");
  act(() =>
    render(
      h(SponsoredCard, {
        budget,
        placement: { turnId: "recheck", chatId: "chat", sponsor },
      }),
      root,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  const frame = root.querySelector<HTMLElement>(".sponsor")!;
  expect(frame.hidden).toBe(false);
  expect(sdk.trackRender).toHaveBeenCalledOnce();

  read.mockClear().mockResolvedValueOnce({ status: "unavailable", reason });
  (event === "focus" ? window : document).dispatchEvent(new Event(event));
  await vi.advanceTimersByTimeAsync(32);
  expect(frame.hidden).toBe(true);
  expect(root.querySelector(".sponsor a")).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();

  document.dispatchEvent(new Event("resume"));
  await vi.advanceTimersByTimeAsync(0);
  expect(frame.hidden).toBe(false);
  expect(root.querySelector(".sponsor a")).toBeTruthy();
  expect(sdk.trackRender).toHaveBeenCalledTimes(2);
});

test("declining consent during a retry wait stops it without another read", async () => {
  setSponsorConsent("allowed");
  vi.useFakeTimers();
  const read = vi
    .spyOn(nativeConsent, "readSponsorConsent")
    .mockResolvedValueOnce({ status: "unavailable", reason: "bridge" } as never);
  act(() =>
    render(
      h(SponsoredCard, {
        budget,
        placement: { turnId: "decline", chatId: "chat", sponsor },
      }),
      root,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  act(() => setSponsorConsent("declined"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledOnce();
  expect(sdk.trackRender).not.toHaveBeenCalled();
  expect(root.querySelector(".sponsor a")).toBeNull();
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
  const clear = vi.spyOn(budget, "dismiss");
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", chatId: "chat", sponsor },
        budget,
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
  expect(root.querySelector(".sponsor-card")?.childElementCount).toBe(0);
});

test("declining suggestions persists the preference and removes advertising identifiers", async () => {
  act(() => render(h(SponsorOptIn, { cardRef: createRef<HTMLElement>() }), root));
  localStorage.setItem("elo_visitor_id", "test-id");
  Cookies.set("_elo_state", "test-id", { path: "" });
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
  const { readSponsorConsent } = await import("../src/suggestions/consent");
  const getState = vi
    .fn()
    .mockResolvedValueOnce({ consentStatus: "unknown", canRequestAds: false })
    .mockRejectedValueOnce(new Error("Bridge offline"))
    // Even a stale canRequestAds flag must not override a required decision.
    .mockResolvedValueOnce({ consentStatus: "required", canRequestAds: true });
  vi.stubGlobal("admob", { privacy: { getState } });
  const signal = new AbortController().signal;
  localStorage.setItem("elo_visitor_id", "fixture");
  Cookies.set("_elo_state", "fixture", { path: "" });
  for (const expected of ["unavailable", "unavailable", "denied"]) {
    expect((await readSponsorConsent(signal)).status).toBe(expected);
    expect(localStorage.getItem("elo_visitor_id")).toBe(expected === "denied" ? null : "fixture");
    expect(document.cookie.includes("_elo_state=fixture")).toBe(expected !== "denied");
  }
});

test("the pinned SDK creates no identifier or network request until required CMP signals exist", async () => {
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
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

test("taps send one event and click notice, then stop retries after opt-out", async () => {
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
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
  act(() =>
    render(
      h(SponsoredCard, {
        budget,
        placement: { turnId: "tap", chatId: "chat", sponsor: sponsor! },
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
  expect(network.mock.calls.filter(([url]) => url === "https://example.org/click")).toHaveLength(1);
  expect(network.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(1);
  act(() => setSponsorConsent("declined"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(network.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(1);
});

test("the real SDK view starts the cooldown after dwell, even if impression delivery fails", async () => {
  setSponsorConsent("allowed");
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/request")
        ? Response.json({
            request_id: "cooldown",
            ad: {
              ...ad,
              render_url: "/render",
              impression_url: "/impression",
            },
          })
        : new Response(null, { status: 204 }),
    ),
  );
  const result = await integration.loadSponsor(["Hosting"], new AbortController().signal, {
    maxHeight: 72,
    maxWidth: 320,
  });
  expect(result).toBeTruthy();
  // Isolate delivery failure while retaining the real SDK view and consent wrapper.
  const { EloSDK } = await import("@elo-ads/web-sdk/core");
  vi.spyOn(EloSDK.prototype, "trackImpression").mockResolvedValue(false);
  vi.useFakeTimers();
  let intersect!: (ratio: number) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: object[]) => void) {
        intersect = (ratio) => callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  const placement = { kind: "waiting" as const, chatId: "chat", turnId: "first", sponsor: result! };
  expect(budget.claim("chat:first")).toBe(0);
  budget.add(placement);
  const viewed = vi.spyOn(budget, "viewed");
  await act(async () => render(h(SponsoredCard, { placement, budget }), root));
  await vi.advanceTimersByTimeAsync(0);
  expect(root.querySelector(".sponsor-card a")).toBeTruthy();
  intersect(0.5);
  await vi.advanceTimersByTimeAsync(999);
  expect(viewed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(viewed).toHaveBeenCalledExactlyOnceWith(placement);
  expect(EloSDK.prototype.trackImpression).toHaveBeenCalledOnce();
  budget.dismiss(placement);
  expect(budget.claim("chat:second")).toBe(300_000);
});

test("an incomplete consent read after dwell retries instead of dropping the impression", async () => {
  setSponsorConsent("allowed");
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
  const native = { canRequestAds: true, consentStatus: "notRequired" };
  const getState = vi.fn(async () => native);
  vi.stubGlobal("admob", { privacy: { getState } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/request")
        ? Response.json({
            request_id: "retry-impression",
            ad: { ...ad, render_url: "/render", impression_url: "/impression" },
          })
        : new Response(null, { status: 204 }),
    ),
  );
  const result = await integration.loadSponsor(["Hosting"], new AbortController().signal, {
    maxHeight: 72,
    maxWidth: 320,
  });
  expect(result).toBeTruthy();
  const { EloSDK } = await import("@elo-ads/web-sdk/core");
  const delivered = vi.spyOn(EloSDK.prototype, "trackImpression").mockResolvedValue(true);
  vi.useFakeTimers();
  let intersect!: (ratio: number) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: object[]) => void) {
        intersect = (ratio) => callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  const placement = { chatId: "chat", turnId: "first", sponsor: result! };
  expect(budget.claim("chat:first")).toBe(0);
  budget.add(placement);
  const viewed = vi.spyOn(budget, "viewed");
  await act(async () => render(h(SponsoredCard, { placement, budget }), root));
  await vi.advanceTimersByTimeAsync(0);
  expect(root.querySelector(".sponsor-card a")).toBeTruthy();
  // The bridge fails once while the card stays in view; the SDK will not re-arm its dwell.
  getState.mockRejectedValueOnce(new Error("Bridge busy"));
  intersect(0.5);
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivered).not.toHaveBeenCalled();
  expect(viewed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(delivered).toHaveBeenCalledOnce();
  expect(viewed).toHaveBeenCalledExactlyOnceWith(placement);
});

test("a native consent change without a lifecycle event suppresses impression and click notices", async () => {
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
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
  vi.spyOn(budget, "dismiss").mockImplementation(() => render(null, root));
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", chatId: "chat", sponsor: result! },
        budget,
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
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
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
  const clear = vi.spyOn(budget, "dismiss").mockImplementation(() => render(null, root));
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", chatId: "chat", sponsor: result! },
        budget,
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
  // An already-mounted view stops as soon as the consent read is unavailable.
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
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
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
  const clear = vi.spyOn(budget, "dismiss").mockImplementation(() => render(null, root));
  act(() =>
    render(
      h(SponsoredCard, {
        placement: { turnId: "1", chatId: "chat", sponsor: original! },
        budget,
      }),
      root,
    ),
  );
  await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
  const firstLink = root.querySelector("a")!;
  getState.mockRejectedValueOnce(new Error("Temporarily unavailable"));
  await act(async () => firstLink.click());
  expect(openCustomTab).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(showToast).toHaveBeenCalledWith("Could not verify ad consent. Please try again."),
  );
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
  const { readSponsorConsent } = await import("../src/suggestions/consent");
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
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

test("the pinned SDK times out a hung fetch and releases the shared request slot", async () => {
  vi.useFakeTimers();
  setSponsorConsent("allowed");
  const integration =
    await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
  const { SponsorSession } = await import("../src/suggestions/session");
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (!url.endsWith("/request")) return new Response(null, { status: 204 });
      requestSignal = options.signal!;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), {
          once: true,
        });
      });
    }),
  );
  const session = new SponsorSession({
    eligible: () => true,
    visible: () => true,
    consent: () => "allowed",
    budget,
    load: (topics, signal) =>
      integration.loadSponsor(topics, signal, { maxHeight: 72, maxWidth: 320 }),
  });
  onTestFinished(() => session.dispose());
  session.update("chat", true, { id: "hung", user: "deploy", streaming: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(requestSignal?.aborted).toBe(false);
  expect(budget.claim("other:turn")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(3000);
  expect(requestSignal?.aborted).toBe(true);
  expect(budget.card("chat")).toBeUndefined();
  expect(budget.claim("other:turn")).toBe(27_000);
});

test.each(["pro", "bridge"])("a silent %s change also hides the opt-in", async (change) => {
  setSponsorConsent("ask");
  const active = () => true;
  const draw = () =>
    act(async () =>
      render(h(Chat, { id: "live", running: true, covered: false, isTabActive: active }), root),
    );
  await draw();
  await vi.waitFor(() => expect(root.querySelector(".sponsor-consent")).toBeTruthy());
  if (change === "pro") vi.stubGlobal("acode", { require: () => ({ HAS_PRO: true }) });
  else vi.stubGlobal("admob", undefined);
  await draw();
  expect(root.querySelector(".sponsor-consent")).toBeNull();
});

test("no-card rerenders skip entitlement lookups", async () => {
  setSponsorConsent("allowed");
  vi.mocked(loadSponsor).mockResolvedValue(null);
  const require = vi.fn(() => ({ HAS_PRO: false }));
  vi.stubGlobal("acode", { require });
  const active = () => true;
  const draw = () =>
    act(async () =>
      render(h(Chat, { id: "live", running: true, covered: false, isTabActive: active }), root),
    );
  await draw();
  require.mockClear();
  await draw();
  expect(root.querySelector(".sponsor")).toBeNull();
  expect(require).not.toHaveBeenCalled();
});

test("a waiting request classifies the latest history even when its turn ID is unchanged", async () => {
  vi.useFakeTimers();
  setSponsorConsent("allowed");
  vi.mocked(loadSponsor).mockResolvedValue(null);
  expect(budget.claim("other:turn")).toBe(0);
  budget.release("other:turn");
  const active = () => true;
  const draw = (previous: string[]) =>
    act(async () =>
      render(
        h(Chat, {
          id: "live",
          running: true,
          covered: false,
          isTabActive: active,
          previous,
        }),
        root,
      ),
    );
  await draw(["SQL"]);
  await draw(["Flutter"]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loadSponsor).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment", "Mobile app development"],
    expect.any(AbortSignal),
    { maxHeight: 72, maxWidth: 320 },
    expect.any(Function),
    expect.any(Function),
  );
});

test("mounts of the same cached creative have independent view signals", async () => {
  setSponsorConsent("allowed");
  const attach = vi.spyOn(sdk, "attachView");
  const placement = { chatId: "chat", turnId: "same", sponsor };
  await act(async () =>
    render(
      h(
        "div",
        null,
        h(SponsoredCard, { placement, budget, key: "a" }),
        h(SponsoredCard, { placement, budget, key: "b" }),
      ),
      root,
    ),
  );
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
  const [a, b] = attach.mock.calls;
  expect(a[0]).not.toBe(b[0]);
  expect(a[0]).toEqual(b[0]);
  await act(async () =>
    render(h("div", null, h(SponsoredCard, { placement, budget, key: "b" })), root),
  );
  expect(a[1].aborted).toBe(true);
  expect(b[1].aborted).toBe(false);
});

test("activity callback replacement keeps the live turn and uses the latest callback", async () => {
  vi.useFakeTimers();
  setSponsorConsent("allowed");
  vi.mocked(loadSponsor).mockResolvedValue(sponsor);
  expect(budget.claim("other:first")).toBe(0);
  budget.release("other:first");
  const draw = (isTabActive: () => boolean) =>
    act(async () =>
      render(
        h(Chat, {
          id: "live",
          running: true,
          covered: false,
          isTabActive,
        }),
        root,
      ),
    );
  await draw(() => false);
  await draw(() => true);
  await draw(() => true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loadSponsor).toHaveBeenCalledOnce();
  expect(root.querySelector(".sponsor a")).toBeTruthy();
});

test("budget changes skip inactive renders and reconcile on activation", async () => {
  setSponsorConsent("allowed");
  let active = false;
  const isTabActive = () => active;
  const rendered = vi.fn();
  function InactiveChat() {
    const ref = useRef<HTMLElement>(null);
    const state = useSponsor(ref, "chat", false, [], false, isTabActive, budget);
    rendered(state.placement?.turnId);
    return h("main", { ref }, state.placement?.turnId ?? "empty");
  }
  await act(async () => render(h(InactiveChat, {}), root));
  rendered.mockClear();
  act(() => {
    expect(budget.claim("chat:cached")).toBe(0);
    budget.add({ chatId: "chat", turnId: "cached", sponsor });
  });
  expect(rendered).not.toHaveBeenCalled();
  active = true;
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(root.textContent).toBe("cached"));
});

test("active budget updates ignore unrelated cards but retain global clears and opt-in changes", async () => {
  setSponsorConsent("allowed");
  let now = 0;
  const localBudget = new SponsorBudget(() => now);
  const active = () => true;
  const rendered = vi.fn();
  function ActiveChat() {
    const ref = useRef<HTMLElement>(null);
    const state = useSponsor(ref, "chat", false, [], false, active, localBudget);
    rendered();
    return h("main", { ref }, state.placement?.turnId ?? "empty");
  }
  await act(async () => render(h(ActiveChat, {}), root));
  rendered.mockClear();
  const other = { chatId: "other", turnId: "other", sponsor };
  await act(async () => {
    expect(localBudget.claim("other:other")).toBe(0);
    localBudget.add(other);
  });
  await act(async () => localBudget.dismiss(other));
  expect(rendered).not.toHaveBeenCalled();

  now += 30_000;
  await act(async () => {
    expect(localBudget.claim("chat:cached")).toBe(0);
    localBudget.add({ chatId: "chat", turnId: "cached", sponsor });
  });
  expect(root.textContent).toBe("cached");
  await act(async () => localBudget.clearCards());
  expect(root.textContent).toBe("empty");

  // Releasing another chat's opt-in ownership affects availability globally.
  await act(async () => localBudget.offerOptIn("other"));
  await act(async () => render(h(ActiveChat, {}), root));
  rendered.mockClear();
  await act(async () => localBudget.forgetChat("other"));
  expect(rendered).toHaveBeenCalled();
});

test.each(["visible", "delivered", "withdrawn", "paused", "unmounted", "denied"] as const)(
  "SDK tap retries respect the view lifecycle: %s",
  async (state) => {
    const integration =
      await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
    setSponsorConsent("allowed");
    const native = { canRequestAds: true, consentStatus: "notRequired" };
    vi.stubGlobal("admob", { privacy: { getState: async () => native } });
    const events = vi.fn(async () => {
      if (state === "delivered") return new Response(null, { status: 204 });
      throw new TypeError("Offline");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/events")) return events();
        if (url.endsWith("/request"))
          return Response.json({
            request_id: "tap-abort",
            ad: {
              ...ad,
              ad_id: "tap-ad",
              opportunity_id: "tap-opportunity",
              render_url: "/render",
              impression_url: "/impression",
            },
          });
        return new Response(null, { status: 204 });
      }),
    );
    const result = await integration.loadSponsor(["Hosting"], new AbortController().signal, {
      maxHeight: 72,
      maxWidth: 320,
    });
    expect(result).toBeTruthy();
    if (!result) throw Error("Expected an eligible sponsor");
    const taps = vi.spyOn(result.sdk, "trackTap");
    await act(async () =>
      render(
        h(SponsoredCard, {
          placement: { turnId: "1", chatId: "chat", sponsor: result },
          budget,
        }),
        root,
      ),
    );
    await vi.waitFor(() => expect(root.querySelector(".sponsor-card a")).toBeTruthy());
    vi.useFakeTimers();
    if (state === "denied") native.canRequestAds = false;
    // Tap inert padding so opening the browser does not dismiss the card first.
    root.querySelector(".sponsor-card")?.dispatchEvent(
      new MouseEvent("click", {
        detail: 1,
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(taps).toHaveBeenCalledOnce();
    const signal = taps.mock.calls[0]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(events).toHaveBeenCalledTimes(state === "denied" ? 0 : 1);
    if (state === "withdrawn") act(() => setSponsorConsent("declined"));
    if (state === "paused") document.dispatchEvent(new Event("pause"));
    if (state === "unmounted") act(() => render(null, root));
    if (state !== "visible" && state !== "delivered") expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    // A visible ad retries twice; a removed or denied view sends nothing further.
    expect(events).toHaveBeenCalledTimes(state === "visible" ? 3 : state === "denied" ? 0 : 1);
    expect(await taps.mock.results[0]?.value).toBe(state === "delivered");
    if (state === "delivered") {
      const call = taps.mock.calls[0];
      if (!call) throw Error("Expected the SDK tap call");
      const aborted = new AbortController();
      aborted.abort();
      await expect(result.sdk.trackTap(call[0], call[1], { signal: aborted.signal })).resolves.toBe(
        false,
      );
      expect(events).toHaveBeenCalledOnce();
    }
    if (signal?.aborted) {
      const call = taps.mock.calls[0];
      if (!call) throw Error("Expected the SDK tap call");
      await expect(result.sdk.trackTap(...call)).resolves.toBe(false);
      expect(events).toHaveBeenCalledTimes(state === "denied" ? 0 : 1);
    }
  },
);

test.each(["slow", "timeout", "dismissed", "browser-failure"] as const)(
  "sponsored navigation handles %s without stale or duplicate opens",
  async (scenario) => {
    const integration =
      await vi.importActual<typeof import("../src/suggestions/elo")>("../src/suggestions/elo");
    setSponsorConsent("allowed");
    const consent = { canRequestAds: true, consentStatus: "notRequired" };
    const getState = vi.fn(async () => consent);
    vi.stubGlobal("admob", { privacy: { getState } });
    const network = vi.fn(async (url: string) =>
      url.endsWith("/request")
        ? Response.json({
            request_id: "slow-open",
            ad: {
              ...ad,
              opportunity_id: "slow-open",
              render_url: "/r",
              impression_url: "/i",
              trackers: [{ event: "click", url: "https://example.org/notice" }],
            },
          })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", network);
    const sponsor = await integration.loadSponsor(["Hosting"], new AbortController().signal, {
      maxHeight: 72,
      maxWidth: 320,
    });
    if (!sponsor) throw Error("Expected a sponsor");
    vi.spyOn(budget, "dismiss").mockImplementation(() => render(null, root));
    await act(async () =>
      render(
        h(SponsoredCard, {
          placement: { chatId: "chat", turnId: "1", sponsor },
          budget,
        }),
        root,
      ),
    );
    await vi.waitFor(() => expect(root.querySelector("a")).toBeTruthy());
    vi.useFakeTimers();
    network.mockClear();
    getState.mockClear();
    let resolveConsent: (value: typeof consent) => void = () => {};
    getState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConsent = resolve;
        }),
    );
    const tap = () =>
      root.querySelector("a")?.dispatchEvent(
        new MouseEvent("click", {
          detail: 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    tap();
    await vi.advanceTimersByTimeAsync(250);
    expect(showToast).toHaveBeenCalledExactlyOnceWith("Opening sponsored link…");
    expect(openCustomTab).not.toHaveBeenCalled();
    tap(); // Elo's repeat guard shares the first pending read and cannot open twice.
    expect(getState).toHaveBeenCalledOnce();
    if (scenario === "timeout") {
      await vi.advanceTimersByTimeAsync(750);
      expect(showToast).toHaveBeenCalledWith("Could not verify ad consent. Please try again.");
    } else if (scenario === "dismissed") {
      act(() => root.querySelector<HTMLButtonElement>(".sponsor-dismiss")?.click());
    } else if (scenario === "browser-failure") {
      vi.mocked(openCustomTab).mockRejectedValueOnce(Error("No browser"));
    }
    await act(async () => {
      resolveConsent(consent);
    });
    await vi.advanceTimersByTimeAsync(0);
    if (scenario === "timeout" || scenario === "dismissed") {
      expect(openCustomTab).not.toHaveBeenCalled();
      expect(
        network.mock.calls.some(([url]) => url.endsWith("/events") || url.endsWith("/notice")),
      ).toBe(false);
      if (scenario === "timeout") {
        // A refreshed view can be retried immediately, even within the old guard interval.
        tap();
        await vi.advanceTimersByTimeAsync(0);
        expect(openCustomTab).toHaveBeenCalledOnce();
      }
    } else {
      expect(openCustomTab).toHaveBeenCalledExactlyOnceWith("https://example.org/");
      if (scenario === "browser-failure")
        expect(showToast).toHaveBeenCalledWith("Could not open this sponsored link.");
    }
  },
);

test("clears current-directory SDK cookies synchronously without touching other cookies", () => {
  const originalUrl = location.href;
  history.replaceState(null, "", "/app/index.html");
  try {
    for (const name of ["_elo_state", "_growl_state"])
      Cookies.set(name, "identity", {
        path: "",
        sameSite: "Lax",
        secure: location.protocol === "https:",
      });
    Cookies.set("unrelated", "keep", { path: "" });
    expect(Cookies.get("_elo_state")).toBe("identity");
    expect(Cookies.get("_growl_state")).toBe("identity");
    const invalidated = vi.fn(() => {
      expect(Cookies.get("_elo_state")).toBeUndefined();
      expect(Cookies.get("_growl_state")).toBeUndefined();
    });
    const unsubscribe = sponsorIdentityCleared.subscribe(invalidated);
    try {
      clearSponsorIdentity();
    } finally {
      unsubscribe();
    }
    expect(invalidated).toHaveBeenCalledOnce();
    expect(Cookies.get("unrelated")).toBe("keep");
  } finally {
    for (const name of ["_elo_state", "_growl_state", "unrelated"])
      Cookies.remove(name, { path: "" });
    history.replaceState(null, "", originalUrl);
  }
});
