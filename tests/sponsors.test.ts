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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ad = { title: "Hosting", click_url: "https://example.com/offer" } as Sponsor["ad"];
const sponsor = { ad } as Sponsor;

function fixture(consent: SponsorConsent = "allowed", budget = new SponsorBudget()) {
  let eligible = true;
  const load = vi.fn(
    async (_context: string[], _signal: AbortSignal): Promise<Sponsor | null> => sponsor,
  );
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
  expect(sponsorContext("deploy secret REDACTED_TOKEN /private/repo customer@example.com")).toEqual(
    ["Cloud hosting and deployment"],
  );
  expect(sponsorContext("password=very-secret\n```private source```")).toEqual([
    "Software development tools",
  ]);
  expect(sponsorContext("Explain SQL errors")).toEqual([
    "Databases and data storage",
    "Software testing and debugging",
    "Learning programming",
  ]);
  expect(sponsorContext("x".repeat(4000) + " hosting")).toEqual(["Software development tools"]);
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
    ["Cloud hosting and deployment"],
    expect.any(AbortSignal),
    false,
  );
});

test.each(["answered", "dismissed", "stopped", "failed", "no fill"])(
  "one waiting request per eligible turn when %s",
  async (outcome) => {
    const f = fixture();
    const wait = (id: string) => {
      f.session.update("chat", true, { id, user: "deploy", streaming: true });
      f.session.showWhileWaiting("chat", id, "deploy");
    };
    for (const id of ["1", "2"]) {
      wait(id);
      expect(f.load).not.toHaveBeenCalled();
      f.finish(id);
    }
    let resolve!: (value: Sponsor | null) => void;
    f.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    wait("3");
    wait("3");
    expect(f.load).toHaveBeenCalledExactlyOnceWith(
      ["Cloud hosting and deployment"],
      expect.any(AbortSignal),
      true,
    );
    if (outcome === "dismissed") f.session.clear();
    f.session.update("chat", false, {
      id: "3",
      user: "deploy",
      answer: "Done",
      stopped: outcome === "stopped",
      error: outcome === "failed" ? "Offline" : undefined,
    });
    expect(f.load.mock.calls[0][1].aborted).toBe(
      ["dismissed", "failed", "stopped"].includes(outcome),
    );
    resolve(outcome === "no fill" ? null : sponsor);
    await Promise.resolve();
    expect(f.session.placement?.sponsor).toBe(outcome === "answered" ? sponsor : undefined);
    expect(f.load).toHaveBeenCalledTimes(1);
  },
);

test("a stale waiting timer cannot spend the current turn's opportunity", async () => {
  const f = fixture();
  f.finish("1");
  f.finish("2");
  for (const id of ["old", "current"])
    f.session.update("chat", true, { id, user: "deploy", streaming: true });
  f.session.showWhileWaiting("chat", "old", "deploy");
  expect(f.load).not.toHaveBeenCalled();
  f.session.showWhileWaiting("chat", "current", "deploy");
  await Promise.resolve();
  expect(f.session.placement?.turnId).toBe("current");
  expect(f.load).toHaveBeenCalledOnce();
});

test("a queued timer firing after a turn stops leaves the next ad opportunity available", () => {
  const f = fixture();
  f.finish("1");
  f.finish("2");
  f.session.update("chat", true, { id: "3", user: "deploy", streaming: true });
  f.session.update("chat", false, { id: "3", user: "deploy", stopped: true });
  f.session.showWhileWaiting("chat", "3", "deploy");
  expect(f.load).not.toHaveBeenCalled();
  f.finish("4");
  expect(f.load).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment"],
    expect.any(AbortSignal),
    false,
  );
});

test("shares frequency caps across chats and tabs, including no-fill attempts", async () => {
  let now = 0;
  const budget = new SponsorBudget(() => now);
  const a = fixture("allowed", budget),
    b = fixture("allowed", budget);
  a.load.mockResolvedValue(null);
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

test("dismissing a filled card permits the next eligible turn after the cooldown", async () => {
  let now = 0;
  const f = fixture("allowed", new SponsorBudget(() => now));
  for (const id of ["1", "2", "3"]) f.finish(id);
  await Promise.resolve();
  expect(f.session.placement?.sponsor).toBe(sponsor);
  f.session.clear();
  for (const id of ["4", "5", "6"]) f.finish(id);
  expect(f.session.placement).toBeUndefined();
  expect(f.load).toHaveBeenCalledTimes(1);
  now = 300_000;
  f.finish("7");
  await Promise.resolve();
  expect(f.session.placement?.turnId).toBe("7");
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
