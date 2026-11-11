import { afterEach, expect, test, vi } from "vitest";
import { sponsorContext } from "../src/ads/context";
import { SponsorBudget, SponsorSession } from "../src/ads/session";
import {
  isFreeAcode,
  setSponsorConsent,
  sponsorConsent,
  type SponsorConsent,
} from "../src/ads/preferences";
import { safeAdUrl, type Sponsor } from "../src/ads/elo";
import { observeSponsor } from "../src/ads/viewability";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ad = { title: "Hosting", click_url: "https://example.com/offer" } as Sponsor["ad"];
const sponsor = { ad } as Sponsor;

function fixture(consent: SponsorConsent = "allowed", budget = new SponsorBudget()) {
  let eligible = true;
  const load = vi.fn(async (_context: string, _signal: AbortSignal) => sponsor);
  const session = new SponsorSession({
    eligible: () => eligible,
    visible: () => true,
    consent: () => consent,
    load,
    budget,
  });
  session.update("chat", false);
  const finish = (id: string, overrides = {}) => {
    session.update("chat", true);
    session.update("chat", false, {
      id,
      user: "Help deploy my private code",
      answer: "Done",
      ...overrides,
    });
  };
  return {
    session,
    load,
    finish,
    consent: (value: SponsorConsent) => {
      consent = value;
    },
    eligible: (value: boolean) => {
      eligible = value;
    },
  };
}

test("only fixed topic labels leave the device, never code, tokens, paths or user text", () => {
  expect(sponsorContext("deploy secret REDACTED_TOKEN /private/repo customer@example.com")).toBe(
    "Cloud hosting and deployment",
  );
  expect(sponsorContext("password=very-secret\n```private source```")).toBe(
    "Software development tools",
  );
  expect(sponsorContext("Explain SQL errors")).toBe("Databases and data storage");
  expect(sponsorContext("x".repeat(4000) + " hosting")).toBe("Software development tools");
});

test("does not monetize restored history, streaming updates, stopped or failed runs", () => {
  const f = fixture();
  f.session.update("chat", false, { id: "old", user: "Old", answer: "Old" });
  f.finish("failed", { error: "Provider failed" });
  f.finish("stopped", { stopped: true });
  f.finish("stream", { streaming: true });
  f.finish("one");
  f.finish("two");
  expect(f.load).not.toHaveBeenCalled();
  f.finish("three");
  expect(f.load).toHaveBeenCalledExactlyOnceWith(
    "Cloud hosting and deployment",
    expect.any(AbortSignal),
  );
});

test("shares frequency caps across chats and tabs, including no-fill attempts", async () => {
  let now = 0;
  const budget = new SponsorBudget(() => now);
  const a = fixture("allowed", budget),
    b = fixture("allowed", budget);
  a.load.mockResolvedValue(null as unknown as Sponsor);
  for (const id of ["one", "two", "three"]) {
    a.finish(id);
    b.finish(id);
  }
  expect(a.load).toHaveBeenCalledTimes(1);
  expect(b.load).not.toHaveBeenCalled();
  for (const id of ["four", "five", "six"]) a.finish(id);
  expect(a.load).toHaveBeenCalledTimes(1);
  now = 300_000;
  a.finish("seven");
  expect(a.load).toHaveBeenCalledTimes(2);
});

test("waits for consent and makes no requests for Pro, declined or unknown eligibility", async () => {
  const f = fixture("ask");
  f.finish("1");
  f.finish("2");
  f.finish("3");
  expect(f.session.placement?.sponsor).toBeUndefined();
  expect(f.session.placement?.turnId).toBe("3");
  expect(f.load).not.toHaveBeenCalled();
  f.consent("allowed");
  f.session.allow();
  await vi.waitFor(() => expect(f.session.placement?.sponsor).toBe(sponsor));
  f.eligible(false);
  f.session.refresh();
  expect(f.session.placement).toBeUndefined();
  f.finish("4");
  f.finish("5");
  f.finish("6");
  expect(f.load).toHaveBeenCalledTimes(1);
  const denied = fixture("declined");
  denied.finish("1");
  denied.finish("2");
  denied.finish("3");
  expect(denied.load).not.toHaveBeenCalled();
  expect(denied.session.placement).toBeUndefined();
});

test.each(["chat", "run", "consent", "pro", "dispose"])(
  "ignores pending ad after %s changes",
  async (change) => {
    const f = fixture();
    let resolve!: (value: Sponsor) => void;
    f.load.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    f.finish("1");
    f.finish("2");
    f.finish("3");
    if (change === "chat") f.session.update("another", false);
    if (change === "run") f.session.update("chat", true);
    if (change === "consent") f.consent("declined");
    if (change === "pro") f.eligible(false);
    if (change === "dispose") f.session.dispose();
    if (change === "pro" || change === "consent") f.session.refresh();
    const signal = f.load.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    resolve(sponsor);
    await Promise.resolve();
    expect(f.session.placement).toBeUndefined();
  },
);

test("host entitlement and unavailable consent storage fail closed", () => {
  vi.stubGlobal("acode", { require: () => ({ HAS_PRO: true }) });
  expect(isFreeAcode()).toBe(false);
  vi.stubGlobal("acode", { require: () => ({ HAS_PRO: false }) });
  expect(isFreeAcode()).toBe(true);
  vi.stubGlobal("acode", { require: () => ({}) });
  expect(isFreeAcode()).toBe(false);
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error();
    },
    setItem: () => {
      throw Error();
    },
  });
  setSponsorConsent("allowed");
  expect(sponsorConsent()).toBe("declined");
  expect(safeAdUrl("javascript:alert(1)")).toBeUndefined();
  expect(safeAdUrl("https://user:pass@example.com")).toBeUndefined();
  expect(safeAdUrl("https://example.com/offer")).toBe("https://example.com/offer");
});

test("impressions require a continuous visible second and stop on background, Pro or disposal", async () => {
  vi.useFakeTimers();
  const document = new EventTarget() as EventTarget & { hidden: boolean };
  document.hidden = false;
  vi.stubGlobal("document", document);
  let intersection!: (entries: unknown[]) => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersection) {
        intersection = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  let eligible = true,
    impressed = false;
  const sdk = {
    trackRender: vi.fn(async () => true),
    hasTrackedImpression: () => impressed,
    trackImpression: vi.fn(async () => {
      impressed = true;
      return true;
    }),
  };
  const stop = observeSponsor(
    {
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
      hasAttribute: () => false,
    } as unknown as HTMLElement,
    { ad, sdk } as unknown as Sponsor,
    () => eligible,
  );
  intersection([{ isIntersecting: true, intersectionRatio: 0.6 }]);
  await vi.advanceTimersByTimeAsync(700);
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(sdk.trackImpression).not.toHaveBeenCalled();
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(900);
  expect(sdk.trackImpression).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.trackImpression).toHaveBeenCalledTimes(1);
  impressed = false;
  eligible = false;
  await vi.advanceTimersByTimeAsync(2000);
  expect(sdk.trackImpression).toHaveBeenCalledTimes(1);
  stop();
  eligible = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(sdk.trackImpression).toHaveBeenCalledTimes(1);
});
