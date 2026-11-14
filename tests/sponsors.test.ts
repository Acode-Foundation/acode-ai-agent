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

function fixture(
  consent: SponsorConsent = "allowed",
  budget = new SponsorBudget(),
  chatId = "chat",
) {
  let eligible = true;
  let visible = true;
  const load = vi.fn(
    async (_context: string[], _signal: AbortSignal): Promise<Sponsor | null> => sponsor,
  );
  const session = new SponsorSession({
    eligible: () => eligible,
    visible: () => visible,
    consent: () => consent,
    load,
    budget,
  });
  session.update(chatId, false);
  const start = (id: string, overrides = {}) =>
    session.update(chatId, true, { id, user: "deploy", streaming: true, ...overrides });
  const finish = (id: string, overrides = {}) =>
    session.update(chatId, false, { id, user: "deploy", answer: "Done", ...overrides });
  return {
    session,
    budget,
    load,
    finish,
    start,
    consent: (value: SponsorConsent) => {
      consent = value;
    },
    visible: (value: boolean) => {
      visible = value;
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

test("requests on the first eligible wait, never from restored history or answers", async () => {
  const f = fixture();
  f.session.update("chat", false, { id: "old", user: "Old", answer: "Old" });
  f.start("answered", { answer: "Writing" });
  f.start("stopped", { stopped: true });
  f.start("failed", { error: "Failed" });
  expect(f.load).not.toHaveBeenCalled();
  f.start("first");
  await Promise.resolve();
  expect(f.load).toHaveBeenCalledExactlyOnceWith(
    ["Cloud hosting and deployment"],
    expect.any(AbortSignal),
  );
  expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
  f.start("first", { answer: "Starting answer" });
  expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
  f.finish("first");
  expect(f.load).toHaveBeenCalledOnce();
});

test.each(["stopped", "failed", "new turn"])(
  "discards a pending ad when the agent has %s",
  async (outcome) => {
    const f = fixture();
    let resolve!: (value: Sponsor) => void;
    f.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.start("first");
    if (outcome === "new turn") f.start("second");
    else
      f.finish("first", {
        stopped: outcome === "stopped",
        error: outcome === "failed" ? "Failed" : undefined,
      });
    expect(f.load.mock.calls[0][1].aborted).toBe(true);
    resolve(sponsor);
    await Promise.resolve();
    expect(f.budget.card("chat")).toBeUndefined();
    expect(f.load).toHaveBeenCalledOnce();
  },
);

test("five minutes starts at view time and survives dismiss, consent toggles and many turns", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("1");
  await Promise.resolve();
  const first = f.budget.card("chat")!;
  await vi.advanceTimersByTimeAsync(10_000);
  f.budget.viewed(first);
  f.budget.dismiss(first);
  f.budget.consentChanged("declined");
  f.budget.consentChanged("allowed");
  for (let i = 2; i < 20; i++) {
    f.start(String(i));
    f.finish(String(i));
  }
  await vi.advanceTimersByTimeAsync(299_999);
  expect(f.load).toHaveBeenCalledOnce();
  f.start("20");
  await vi.advanceTimersByTimeAsync(1);
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
});

test("idle time never shows an ad; the next wait is eligible without a turn count", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("1");
  await Promise.resolve();
  f.budget.viewed(f.budget.card("chat")!);
  f.finish("1");
  await vi.advanceTimersByTimeAsync(600_000);
  f.session.refresh();
  expect(f.load).toHaveBeenCalledOnce();
  f.start("2");
  expect(f.load).toHaveBeenCalledTimes(2);
});

test("a finish at the cooldown boundary cancels the waiting timer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("1");
  await Promise.resolve();
  f.budget.viewed(f.budget.card("chat")!);
  f.finish("1");
  f.start("2");
  await vi.advanceTimersByTimeAsync(299_999);
  f.finish("2");
  await vi.advanceTimersByTimeAsync(1);
  expect(f.load).toHaveBeenCalledOnce();
});

test.each(["empty", "error"])(
  "%s requests use a short backoff and retry on a later turn",
  async (outcome) => {
    vi.useFakeTimers();
    const f = fixture();
    if (outcome === "empty") f.load.mockResolvedValueOnce(null);
    if (outcome === "error") f.load.mockRejectedValueOnce(Error("Offline"));
    f.start("1");
    await Promise.resolve();
    f.finish("1");
    f.start("2");
    f.finish("2");
    await vi.advanceTimersByTimeAsync(30_000);
    f.session.refresh();
    expect(f.load).toHaveBeenCalledOnce();
    f.start("3");
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
  },
);

test("one request and a shared view cooldown across tabs", async () => {
  vi.useFakeTimers();
  const budget = new SponsorBudget();
  const a = fixture("allowed", budget),
    b = fixture("allowed", budget, "other-chat");
  let resolve!: (value: Sponsor) => void;
  a.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  a.start("a");
  await vi.advanceTimersByTimeAsync(60_000);
  b.start("b");
  expect(b.load).not.toHaveBeenCalled();
  resolve(sponsor);
  await Promise.resolve();
  budget.viewed(budget.card("chat")!);
  a.finish("a");
  await vi.advanceTimersByTimeAsync(299_999);
  expect(b.load).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(b.load).toHaveBeenCalledOnce();
});

test("remounting or retrying an impression does not extend the cooldown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("1");
  await Promise.resolve();
  const first = f.budget.card("chat")!;
  f.budget.viewed(first);
  await vi.advanceTimersByTimeAsync(100_000);
  f.budget.viewed(first);
  f.finish("1");
  f.start("2");
  await vi.advanceTimersByTimeAsync(200_000);
  expect(f.load).toHaveBeenCalledTimes(2);
});

test("a cached ad survives hidden replies and is reused in the next wait", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("1");
  await Promise.resolve();
  f.visible(false);
  f.finish("1");
  expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
  await vi.advanceTimersByTimeAsync(30_000);
  f.visible(true);
  f.start("2");
  expect(f.load).toHaveBeenCalledOnce();
});

test("consenting during a wait allows the first ad immediately", async () => {
  const f = fixture("ask");
  f.start("1");
  expect(f.load).not.toHaveBeenCalled();
  f.consent("allowed");
  f.budget.consentChanged("allowed");
  f.session.refresh();
  await Promise.resolve();
  expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
  f.eligible(false);
  f.session.refresh();
  expect(f.budget.card("chat")).toBeUndefined();
  f.start("2");
  expect(f.load).toHaveBeenCalledOnce();
  const denied = fixture("declined");
  denied.start("1");
  expect(denied.load).not.toHaveBeenCalled();
});

test.each(["chat", "consent", "pro", "dispose", "hidden"])(
  "ignores pending ad after %s changes",
  async (change) => {
    const f = fixture();
    let resolve!: (value: Sponsor) => void;
    f.load.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    f.start("1");
    if (change === "chat") f.session.update("another", false);
    if (change === "consent") f.consent("declined");
    if (change === "pro") f.eligible(false);
    if (change === "dispose") f.session.dispose();
    if (change === "hidden") f.visible(false);
    f.session.refresh();
    expect(f.load.mock.calls[0][1].aborted).toBe(true);
    resolve(sponsor);
    await Promise.resolve();
    expect(f.budget.card("chat")).toBeUndefined();
  },
);

test("cached ads expire after five minutes, including during a single long wait", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("long");
  await Promise.resolve();
  const original = f.budget.card("chat");
  await vi.advanceTimersByTimeAsync(299_999);
  expect(f.budget.card("chat")).toBe(original);
  expect(f.load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.budget.card("chat")).not.toBe(original);
  f.finish("long");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(f.budget.card("chat")).toBeUndefined();
  expect(f.load).toHaveBeenCalledTimes(2);
});

test("dismissal removes the cached ad across later waits and keeps its view cooldown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start("1");
  await Promise.resolve();
  const original = f.budget.card("chat")!;
  f.budget.viewed(original);
  f.finish("1");
  f.start("2");
  expect(f.budget.card("chat")).toBe(original);
  f.budget.dismiss(original);
  f.finish("2");
  f.start("3");
  await vi.advanceTimersByTimeAsync(299_999);
  expect(f.budget.card("chat")).toBeUndefined();
  expect(f.load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.load).toHaveBeenCalledTimes(2);
});

test("chat history supplies only bounded fixed topics, with current prompts taking priority", () => {
  expect(
    sponsorContext("continue", ["deploy /private/secret with token=REDACTED", "SQL database"]),
  ).toEqual(["Databases and data storage", "Cloud hosting and deployment"]);
  expect(sponsorContext("Flutter API", ["deploy", "SQL"])).toEqual([
    "Mobile app development",
    "Backend development",
    "Databases and data storage",
  ]);
  expect(sponsorContext("continue", ["deploy", "okay", "yes", "next", "go ahead"])).toEqual([
    "Software development tools",
  ]);
  expect(sponsorContext("continue", ["x".repeat(4000) + "deploy"])).toEqual([
    "Software development tools",
  ]);
  const f = fixture();
  f.session.update("chat", true, { id: "1", user: "continue", streaming: true }, ["SQL database"]);
  expect(f.load).toHaveBeenCalledExactlyOnceWith(
    ["Databases and data storage"],
    expect.any(AbortSignal),
  );
});

test("a fast answer keeps the same pending ad without a second request", async () => {
  const f = fixture();
  let resolve!: (value: Sponsor) => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.start("fast");
  f.finish("fast");
  expect(f.load.mock.calls[0][1].aborted).toBe(false);
  resolve(sponsor);
  await vi.waitFor(() => expect(f.budget.card("chat")?.sponsor).toBe(sponsor));
  expect(f.budget.card("chat")?.sponsor).toBe(sponsor);
  expect(f.load).toHaveBeenCalledOnce();
});

test("explicit dismissal suppresses ads for five minutes across chats even before dwell", async () => {
  vi.useFakeTimers();
  const budget = new SponsorBudget();
  const a = fixture("allowed", budget),
    b = fixture("allowed", budget, "other");
  a.start("1");
  await Promise.resolve();
  budget.dismiss(budget.card("chat")!, true);
  b.start("1");
  await vi.advanceTimersByTimeAsync(299_999);
  expect(b.load).not.toHaveBeenCalled();
  expect(budget.card("chat")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(b.load).toHaveBeenCalledOnce();
});

test("backgrounding during a streaming answer cancels the still-pending waiting request", async () => {
  const f = fixture();
  let resolve!: (value: Sponsor) => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.start("1");
  f.start("1", { answer: "Starting answer" });
  expect(f.load.mock.calls[0][1].aborted).toBe(false);
  f.visible(false);
  f.session.refresh();
  expect(f.load.mock.calls[0][1].aborted).toBe(true);
  resolve(sponsor);
  await Promise.resolve();
  expect(f.budget.card("chat")).toBeUndefined();
});

test("an in-flight response cannot undo a dismissal from another chat", async () => {
  vi.useFakeTimers();
  const budget = new SponsorBudget();
  const original = { chatId: "old", turnId: "1", sponsor };
  expect(budget.claim("old:1")).toBe(0);
  budget.add(original);
  await vi.advanceTimersByTimeAsync(30_000);
  const f = fixture("allowed", budget);
  let resolve!: (value: Sponsor) => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.start("1");
  budget.dismiss(original, true);
  resolve(sponsor);
  await Promise.resolve();
  expect(budget.card("chat")).toBeUndefined();
  expect(budget.card("old")).toBeUndefined();
  f.start("2");
  await vi.advanceTimersByTimeAsync(299_999);
  expect(f.load).toHaveBeenCalledOnce();
});

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

test("forgetting a chat notifies for its unanswered offer or cached card only", () => {
  const budget = new SponsorBudget();
  const changed = vi.fn();
  budget.changes.subscribe(changed);
  budget.optInChatId = "offered";
  budget.forgetChat("unrelated");
  expect(changed).not.toHaveBeenCalled();
  budget.forgetChat("offered");
  expect(budget.optInChatId).toBeUndefined();
  expect(changed).toHaveBeenCalledOnce();
  expect(budget.claim("cached:1")).toBe(0);
  budget.add({ chatId: "cached", turnId: "1", sponsor });
  changed.mockClear();
  budget.forgetChat("cached");
  expect(budget.card("cached")).toBeUndefined();
  expect(changed).toHaveBeenCalledOnce();
});

test("a waiting chat wakes after an empty request and respects backoff", async () => {
  vi.useFakeTimers();
  const budget = new SponsorBudget();
  const a = fixture("allowed", budget),
    b = fixture("allowed", budget, "other");
  let finish!: (value: null) => void;
  a.load.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  a.start("a");
  b.start("b");
  finish(null);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(b.load).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(b.load).toHaveBeenCalledOnce();
  expect(a.load).toHaveBeenCalledOnce();
  a.session.dispose();
  b.session.dispose();
});

test("a deleted chat cannot regain its ad from a late response", async () => {
  const f = fixture();
  let finish!: (value: Sponsor) => void;
  f.load.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  f.start("live");
  const signal = f.load.mock.calls[0][1];
  f.budget.forgetChat("unrelated");
  expect(signal.aborted).toBe(false);
  f.budget.forgetChat("chat");
  expect(signal.aborted).toBe(true);
  expect(f.budget.claim("other:turn")).toBeGreaterThan(0);
  finish(sponsor);
  await Promise.resolve();
  expect(f.budget.card("chat")).toBeUndefined();
  f.session.dispose();
});
