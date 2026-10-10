import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/platform/promptImages", async (original) => ({
  ...(await original<typeof import("../src/platform/promptImages")>()),
  imageContentFromBytes: vi.fn(async () => ({
    type: "image",
    data: "fixture",
    mimeType: "image/jpeg",
  })),
}));
import { imageContentFromBytes } from "../src/platform/promptImages";
import { attachmentFromMediaFile, pickAcodeFile } from "../src/platform/deviceFile";

beforeEach(() => {
  vi.stubGlobal("Bridge", { platformId: "ios" });
  vi.stubGlobal("acode", {
    require: vi.fn(() => {
      throw Error("Acode browser must not open for media");
    }),
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test("iOS media selection turns a photo into an image attachment with the resize setting", async () => {
  const photo = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
  expect(await attachmentFromMediaFile(photo, false)).toMatchObject({
    name: "photo.jpg",
    type: "image",
    data: "fixture",
    uri: undefined,
  });
  expect(imageContentFromBytes).toHaveBeenCalledWith(
    new Uint8Array([1, 2, 3]),
    "photo.jpg",
    "image/jpeg",
    false,
  );
  expect(acode.require).not.toHaveBeenCalled();
});

test("Choose File from the media chooser retains text attachments", async () => {
  const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
  expect(await attachmentFromMediaFile(notes)).toMatchObject({
    name: "notes.txt",
    content: "hello",
    encoding: "text",
    truncated: false,
  });
});

test.each(["ios", "android"])(
  "%s can explicitly attach from the Acode file browser",
  async (platformId) => {
    vi.stubGlobal("Bridge", { platformId });
    const browser = vi.fn(async () => ({ name: "notes.txt", url: "content://files/1" }));
    vi.stubGlobal("acode", {
      require: () => browser,
      fsOperation: () => ({ readFile: async () => new TextEncoder().encode("hello").buffer }),
    });
    expect(await pickAcodeFile()).toMatchObject({
      name: "notes.txt",
      uri: "content://files/1",
      content: "hello",
    });
    expect(browser).toHaveBeenCalledWith("file", "Choose a file to attach", true);
  },
);
