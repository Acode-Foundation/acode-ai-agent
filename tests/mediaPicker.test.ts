import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { pickMediaFile } from "../src/platform/mediaPicker";

let input: EventTarget & Record<string, any>;
beforeEach(() => {
  input = Object.assign(new EventTarget(), {
    files: [],
    style: {},
    click: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
  });
  vi.stubGlobal("document", { createElement: vi.fn(() => input), body: { append: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

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
});
