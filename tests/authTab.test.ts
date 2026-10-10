import { afterEach, expect, test, vi } from "vitest";
import { closeAuthTab, openAuthTab, openCustomTab } from "../src/platform/authTab.ts";

afterEach(() => vi.unstubAllGlobals());

test.each(["helper", "bridge"])(
  "authentication opens a custom tab through the %s",
  async (path) => {
    const customOpen = vi.fn((url, options, success) => success({ type: "opened" }));
    const exec = vi.fn((success) => success());
    vi.stubGlobal("CustomTabs", path === "helper" ? { open: customOpen } : undefined);
    vi.stubGlobal("cordova", { exec });
    const options = { signal: new AbortController().signal, onReturn: vi.fn() };
    await openAuthTab("https://auth.example.test/device", options);
    if (path === "helper") {
      expect(customOpen).toHaveBeenCalledWith(
        "https://auth.example.test/device",
        { showTitle: true, reportLifecycle: true, authTabId: expect.any(String) },
        expect.any(Function),
        expect.any(Function),
      );
      expect(exec).not.toHaveBeenCalled();
    } else
      expect(exec).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
        "CustomTabs",
        "open",
        [
          "https://auth.example.test/device",
          { showTitle: true, reportLifecycle: true, authTabId: expect.any(String) },
        ],
      );
    options.signal.dispatchEvent(new Event("abort"));
  },
);

test("rejects a failed tab launch and non-http URLs", async () => {
  const exec = vi.fn((success, error) => error("No browser available"));
  vi.stubGlobal("cordova", { exec });
  await expect(openAuthTab("https://auth.example.test/")).rejects.toThrow("No browser available");
  await expect(openAuthTab("javascript:alert(1)")).rejects.toThrow(/http/);
  expect(exec).toHaveBeenCalledTimes(1);
});

test("completion closes only the active auth tab and remains compatible with older hosts", async () => {
  const exec = vi.fn((success, error, service, action) => {
    if (action === "open") success({ type: "opened" });
    else error("Unknown action");
  });
  vi.stubGlobal("cordova", { exec });
  const old = new AbortController();
  await openAuthTab("https://auth.example.test/old", { signal: old.signal, onReturn: vi.fn() });
  const oldId = exec.mock.calls[0]?.[4]?.[1]?.authTabId;
  await openAuthTab("https://auth.example.test/new", {
    signal: new AbortController().signal,
    onReturn: vi.fn(),
  });
  const newId = exec.mock.calls[1]?.[4]?.[1]?.authTabId;
  old.abort();
  closeAuthTab();
  expect(newId).not.toBe(oldId);
  expect(exec).toHaveBeenLastCalledWith(
    expect.any(Function),
    expect.any(Function),
    "CustomTabs",
    "close",
    [newId],
  );
  closeAuthTab();
  expect(exec).toHaveBeenCalledTimes(3);
});

test.each(["helper", "bridge"])("markdown links retain the custom tab %s path", async (path) => {
  const exec = vi.fn((success) => success());
  const open = vi.fn((url, options, success) => success());
  vi.stubGlobal("cordova", { exec });
  vi.stubGlobal("CustomTabs", path === "helper" ? { open } : undefined);
  await openCustomTab("https://example.com/docs");
  if (path === "helper")
    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      { showTitle: true },
      expect.any(Function),
      expect.any(Function),
    );
  else
    expect(exec).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      "CustomTabs",
      "open",
      ["https://example.com/docs", { showTitle: true }],
    );
});

test("resume restores sign-in once and cancelled browser attempts stop listening", async () => {
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", document);
  vi.stubGlobal("cordova", { exec: (success: () => void) => success() });
  const onReturn = vi.fn();
  const cancelled = new AbortController();
  await openAuthTab("https://auth.example.test/old", { signal: cancelled.signal, onReturn });
  cancelled.abort();
  document.dispatchEvent(new Event("resume"));
  expect(onReturn).not.toHaveBeenCalled();
  await openAuthTab("https://auth.example.test/new", {
    signal: new AbortController().signal,
    onReturn,
  });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(onReturn).not.toHaveBeenCalled();
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  document.dispatchEvent(new Event("resume"));
  expect(onReturn).toHaveBeenCalledTimes(1);
});

test("native close restores sign-in once and an aborted attempt ignores late callbacks", async () => {
  const document = new EventTarget();
  vi.stubGlobal("document", document);
  let callback!: (event: { type: string }) => void;
  vi.stubGlobal("cordova", {
    exec(success: typeof callback) {
      callback = success;
      success({ type: "opened" });
    },
  });
  const onReturn = vi.fn();
  await openAuthTab("https://auth.example.test/", {
    signal: new AbortController().signal,
    onReturn,
  });
  expect(onReturn).not.toHaveBeenCalled();
  callback({ type: "closed" });
  callback({ type: "closed" });
  document.dispatchEvent(new Event("resume"));
  expect(onReturn).toHaveBeenCalledTimes(1);
  const cancelled = new AbortController();
  vi.stubGlobal("cordova", {
    exec: (success: typeof callback) => {
      callback = success;
    },
  });
  const pending = openAuthTab("https://auth.example.test/", { signal: cancelled.signal, onReturn });
  cancelled.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  callback({ type: "closed" });
  document.dispatchEvent(new Event("resume"));
  expect(onReturn).toHaveBeenCalledTimes(1);
});
