import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CdpUnavailableError, waitForAcode } from "./e2e/startup.mjs";

const target = { url: "https://localhost/index.html", id: "new" };
const ready = { debug: true, emulator: true, ready: true, version: "test" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("rediscovers the target after transient startup failures and waits for host readiness", async () => {
  const stale = { ...target, id: "old" };
  const pages = vi
    .fn()
    .mockRejectedValueOnce(new CdpUnavailableError("Connection refused"))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([stale])
    .mockResolvedValue([target]);
  const evaluate = vi
    .fn()
    .mockRejectedValueOnce(new CdpUnavailableError("Execution context destroyed"))
    .mockResolvedValueOnce({ ready: false })
    .mockResolvedValue(ready);
  const result = waitForAcode(pages, evaluate);
  await vi.advanceTimersByTimeAsync(800);
  await expect(result).resolves.toEqual({
    main: target,
    environment: { debug: true, emulator: true, version: "test" },
  });
  expect(evaluate.mock.calls.map(([page]) => page.id)).toEqual(["old", "new", "new"]);
});

it.each([null, undefined])(
  "retries a missing snapshot (%s) after the polling delay",
  async (snapshot) => {
    const pages = vi.fn().mockResolvedValue([target]);
    const evaluate = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(ready);
    const result = waitForAcode(pages, evaluate);
    await vi.advanceTimersByTimeAsync(199);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ main: target });
    expect(evaluate).toHaveBeenCalledTimes(2);
  },
);

it("surfaces evaluation failures immediately instead of retrying test errors", async () => {
  const pages = vi.fn().mockResolvedValue([target]);
  const failure = new Error("ReferenceError: broken startup expression");
  await expect(waitForAcode(pages, vi.fn().mockRejectedValue(failure))).rejects.toBe(failure);
  expect(pages).toHaveBeenCalledTimes(1);
});

it.each([{ debug: false }, { emulator: false }])("rejects an unsafe host: %o", async (unsafe) => {
  const pages = vi.fn().mockResolvedValue([target]);
  await expect(
    waitForAcode(pages, vi.fn().mockResolvedValue({ ...ready, ...unsafe })),
  ).rejects.toThrow("disposable debug emulator");
  expect(pages).toHaveBeenCalledTimes(1);
});

it("bounds startup retries and reports the last transport error", async () => {
  const failure = new CdpUnavailableError("WebView connection closed");
  const pages = vi.fn().mockRejectedValue(failure);
  const result = waitForAcode(pages, vi.fn(), 450).catch((error) => error);
  await vi.advanceTimersByTimeAsync(450);
  const error = await result;
  expect(error.message).toContain("Timed out waiting for Acode startup");
  expect(error.message).toContain(failure.message);
  expect(error.cause).toBe(failure);
  expect(pages.mock.calls.map(([timeout]) => timeout)).toEqual([450, 250, 50]);
});
