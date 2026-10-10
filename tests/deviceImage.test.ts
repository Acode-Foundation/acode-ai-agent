import { afterEach, expect, test, vi } from "vitest";

vi.mock("../src/platform/promptImages", async (original) => ({
  ...(await original<typeof import("../src/platform/promptImages")>()),
  imageContentFromBytes: vi.fn(async () => ({
    type: "image",
    data: "fixture",
    mimeType: "image/jpeg",
  })),
}));
import { imageContentFromBytes } from "../src/platform/promptImages";
import { isIOSHost, pickDeviceImage } from "../src/platform/deviceImage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fileReader() {
  const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
  const fsOperation = vi.fn(() => ({ readFile }));
  vi.stubGlobal("acode", { fsOperation });
  return fsOperation;
}

test("Photo Library uses the gallery API and keeps the selected image and resize setting", async () => {
  const fs = fileReader();
  const getImage = vi.fn((success) => success("file:///cache/photo.jpg"));
  const openDocumentFile = vi.fn();
  vi.stubGlobal("sdcard", { getImage, openDocumentFile });
  const image = await pickDeviceImage(false);
  expect(getImage).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), "image/*");
  expect(openDocumentFile).not.toHaveBeenCalled();
  expect(fs).toHaveBeenCalledWith("file:///cache/photo.jpg");
  expect(image).toMatchObject({
    name: "photo.jpg",
    uri: "file:///cache/photo.jpg",
    data: "fixture",
  });
  expect(imageContentFromBytes).toHaveBeenCalledWith(
    new Uint8Array([1, 2, 3]),
    "photo.jpg",
    "image/jpeg",
    false,
  );
});

test("cancelling the gallery creates no attachment", async () => {
  const fs = fileReader();
  vi.stubGlobal("Bridge", {
    platformId: "ios",
  });
  vi.stubGlobal("sdcard", {
    openDocumentFile: vi.fn(),
    getImage: (ok: unknown, fail: (e: string) => void) => fail("Operation cancelled"),
  });
  expect(await pickDeviceImage()).toBeUndefined();
  expect(fs).not.toHaveBeenCalled();
});

test("Android gallery uses metadata instead of an extensionless content URI", async () => {
  const name = "photo";
  const type = "image/jpeg";
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const original = await vi.importActual<typeof import("../src/platform/promptImages")>(
    "../src/platform/promptImages",
  );
  vi.mocked(imageContentFromBytes).mockImplementationOnce(original.imageContentFromBytes);
  const uri = "content://media/external/images/media/12345";
  const stat = vi.fn(async () => ({ name, type }));
  const readFile = vi.fn(async () => bytes.buffer);
  vi.stubGlobal("Bridge", { platformId: "android" });
  vi.stubGlobal("sdcard", {
    openDocumentFile: vi.fn(),
    getImage: (ok: (uri: string) => void) => ok(uri),
  });
  const fsOperation = vi.fn(() => ({ stat, readFile }));
  vi.stubGlobal("acode", { fsOperation });
  expect(await pickDeviceImage(false)).toMatchObject({
    name,
    uri,
    type: "image",
    mimeType: type,
    data: btoa(String.fromCharCode(...bytes)),
  });
  expect(stat).toHaveBeenCalledOnce();
  expect(fsOperation).toHaveBeenCalledWith(uri);
});

test("hosts without the gallery API retain image file picking", async () => {
  vi.stubGlobal("Bridge", { platformId: "android" });
  expect(isIOSHost()).toBe(false);
  const fs = fileReader();
  vi.stubGlobal("sdcard", {
    openDocumentFile: (ok: (e: unknown) => void) =>
      ok({ uri: "content://images/1", filename: "picked.png", type: "image/png" }),
  });
  expect(await pickDeviceImage()).toMatchObject({ name: "picked.png", uri: "content://images/1" });
  expect(fs).toHaveBeenCalledWith("content://images/1");
});

test("an extensionless gallery image remains readable when metadata fails", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const original = await vi.importActual<typeof import("../src/platform/promptImages")>(
    "../src/platform/promptImages",
  );
  vi.mocked(imageContentFromBytes).mockImplementationOnce(original.imageContentFromBytes);
  const uri = "content://media/external/images/media/12345";
  vi.stubGlobal("sdcard", {
    openDocumentFile: vi.fn(),
    getImage: (ok: (uri: string) => void) => ok(uri),
  });
  vi.stubGlobal("acode", {
    fsOperation: () => ({
      stat: async () => {
        throw new Error("Metadata unavailable");
      },
      readFile: async () => bytes.buffer,
    }),
  });
  expect(await pickDeviceImage(false)).toMatchObject({
    uri,
    name: "12345",
    mimeType: "image/jpeg",
    data: btoa(String.fromCharCode(...bytes)),
  });
});
