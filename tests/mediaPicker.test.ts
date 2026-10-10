import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { pickMediaFile } from "../src/platform/mediaPicker";

let input: EventTarget & Record<string, any>;
let window: EventTarget;
let document: EventTarget & { visibilityState: string };
beforeEach(() => {
  vi.useFakeTimers();
  input = Object.assign(new EventTarget(), {
    files: [],
    style: {},
    click: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
  });
  document = Object.assign(new EventTarget(), {
    createElement: vi.fn(() => input),
    body: { append: vi.fn() },
    visibilityState: "visible",
  });
  window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("requests the native photo chooser synchronously without forcing camera", async () => {
  const picked = pickMediaFile();
  expect(input.type).toBe("file");
  expect(input.accept).toBe("image/*");
  expect(input.capture).toBeUndefined();
  expect(input.click).toHaveBeenCalledTimes(1);
  const image = { name: "photo.jpg", type: "image/jpeg" };
  input.files = [image];
  input.dispatchEvent(new Event("change"));
  expect(await picked).toBe(image);
  expect(input.remove).toHaveBeenCalledTimes(1);
  input.dispatchEvent(new Event("cancel"));
  expect(input.remove).toHaveBeenCalledTimes(1);
});

test.each(["cancel", "change"])(
  "dismissal through %s resolves and removes the input, allowing another attachment",
  async (event) => {
    const picked = pickMediaFile();
    input.dispatchEvent(new Event(event));
    expect(await picked).toBeUndefined();
    expect(input.remove).toHaveBeenCalledTimes(1);
  },
);

test("failure opening the picker removes the temporary input", async () => {
  input.click.mockImplementation(() => {
    throw new Error("Picker unavailable");
  });
  await expect(pickMediaFile()).rejects.toThrow("Picker unavailable");
  expect(input.remove).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["focus", "resume", "visibilitychange"])(
  "return through %s recovers from a missing cancel event",
  async (event) => {
    const picked = pickMediaFile();
    (event === "focus" ? window : document).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(input.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await picked).toBeUndefined();
    expect(input.remove).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("resume"));
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("return focus allows a delayed selection and ignores visibility loss", async () => {
  const picked = pickMediaFile();
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(input.remove).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(500);
  const image = { name: "photo.jpg" };
  input.files = [image];
  input.dispatchEvent(new Event("change"));
  expect(await picked).toBe(image);
  expect(vi.getTimerCount()).toBe(0);
});

test("return focus resolves a file that is already selected without waiting for change", async () => {
  const picked = pickMediaFile();
  window.dispatchEvent(new Event("focus"));
  const image = { name: "photo.jpg" };
  input.files = [image];
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await picked).toBe(image);
  expect(vi.getTimerCount()).toBe(0);
});

test("a selection reported long after return focus is still attached", async () => {
  const picked = pickMediaFile();
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(5_000);
  const image = { name: "icloud.jpg" };
  input.files = [image];
  input.dispatchEvent(new Event("change"));
  expect(await picked).toBe(image);
  expect(input.remove).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("missing selection and return events eventually release the picker", async () => {
  const picked = pickMediaFile();
  await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
  expect(await picked).toBeUndefined();
  expect(input.remove).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
