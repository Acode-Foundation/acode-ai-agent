import { afterEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_CONTEXT as context,
  getOrThrow,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import { openCordovaSessionReader, SessionLineReader } from "../src/platform/sessionLineReader";

afterEach(() => vi.unstubAllGlobals());

function setup(text: string) {
  const bytes = new TextEncoder().encode(text);
  const read = vi.fn(async (start: number, end: number) => bytes.slice(start, end).buffer);
  return { reader: new SessionLineReader({ size: bytes.length, read }, "/chat.jsonl"), read };
}

test.each(["", "\n", "one\n\nlast", "one\r\ntwo\n", "unterminated"])(
  "preserves exact lines and termination for %j",
  async (text) => {
    const { reader } = setup(text);
    const lines = [];
    for (;;) {
      const line = getOrThrow(await reader.readLine(context));
      if (line === undefined) break;
      lines.push(line);
    }
    expect(lines.map((line) => line.text + (line.terminated ? "\n" : "")).join("")).toBe(text);
    expect(lines.filter((line) => !line.terminated)).toHaveLength(
      text && !text.endsWith("\n") ? 1 : 0,
    );
    expect(getOrThrow(await reader.readLine(context))).toBeUndefined();
  },
);

test("reads lazily and decodes UTF-8 split across 64 KB chunks", async () => {
  const long = "a".repeat(65528) + "👋世界";
  const { reader, read } = setup("header\n" + long + "\ntail");
  expect(read).not.toHaveBeenCalled();
  expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "header", terminated: true });
  expect(read).toHaveBeenCalledTimes(1);
  expect(getOrThrow(await reader.readLine(context))).toEqual({ text: long, terminated: true });
  expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "tail", terminated: false });
  for (const [start, end] of read.mock.calls) expect(end - start).toBeLessThanOrEqual(65536);
});

test("cancelled reads do not skip bytes and close prevents further reads", async () => {
  const bytes = new TextEncoder().encode("hello\n");
  let finish!: (bytes: ArrayBuffer) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(bytes.buffer);
  const reader = new SessionLineReader({ size: bytes.length, read }, "/chat");
  const controller = new AbortController();
  const pending = reader.readLine(withAbortSignal(controller.signal, context));
  controller.abort();
  finish(bytes.buffer);
  expect(await pending).toMatchObject({ ok: false, error: { code: "aborted" } });
  expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "hello", terminated: true });
  expect(read.mock.calls.map((call) => call[0])).toEqual([0, 0]);
  await reader.close(context);
  await reader.close(context);
  expect(await reader.readLine(context)).toMatchObject({ ok: false, error: { code: "invalid" } });
});

test("I/O errors are Results and can be retried", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce({ code: 1 })
    .mockResolvedValue(new TextEncoder().encode("x").buffer);
  const reader = new SessionLineReader({ size: 1, read }, "/chat");
  expect(await reader.readLine(context)).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "x", terminated: false });
});

function cordovaMock(stall = false) {
  const bytes = new TextEncoder().encode("header\n" + "x".repeat(70000));
  const slice = vi.fn((start: number, end: number) => ({ start, end }));
  const abort = vi.fn();
  class Reader {
    result?: ArrayBuffer;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    abort = abort;
    readAsArrayBuffer(part: { start: number; end: number }) {
      this.result = bytes.slice(part.start, part.end).buffer;
      if (!stall) this.onload?.();
    }
  }
  vi.stubGlobal("FileReader", Reader);
  const resolve = vi.fn((_uri, success) =>
    success({ file: (done: (file: unknown) => void) => done({ size: bytes.length, slice }) }),
  );
  vi.stubGlobal("resolveLocalFileSystemURL", resolve);
  return { slice, abort, resolve };
}

test("Cordova uses native file slices and FileReader without whole-file reads", async () => {
  const { slice, resolve } = cordovaMock();
  const reader = await openCordovaSessionReader("file:///private/chat", "/chat", context);
  expect(resolve.mock.calls[0][0]).toBe("file:///private/chat");
  expect(slice).not.toHaveBeenCalled();
  expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "header", terminated: true });
  expect(slice.mock.calls).toEqual([[0, 65536]]);
  await reader.close(context);
});

test.each(["cancel", "close"])("%s aborts an in-flight Cordova read", async (action) => {
  const { abort } = cordovaMock(true);
  const reader = await openCordovaSessionReader("file:///private/chat", "/chat", context);
  const controller = new AbortController();
  const pending = reader.readLine(withAbortSignal(controller.signal, context));
  if (action === "cancel") controller.abort();
  else await reader.close(context);
  expect(await pending).toMatchObject({ ok: false, error: { code: "aborted" } });
  expect(abort).toHaveBeenCalledTimes(1);
});

test("cancellation while resolving a Cordova file rejects promptly", async () => {
  vi.stubGlobal("resolveLocalFileSystemURL", vi.fn());
  const controller = new AbortController();
  const pending = openCordovaSessionReader(
    "file:///private/chat",
    "/chat",
    withAbortSignal(controller.signal, context),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
});

test("close remains safe when native abort throws", async () => {
  const { abort } = cordovaMock(true);
  abort.mockImplementation(() => {
    throw new Error("native cleanup failed");
  });
  const reader = await openCordovaSessionReader("file:///private/chat", "/chat", context);
  const pending = reader.readLine(context);
  await expect(reader.close(context)).resolves.toBeUndefined();
  expect(await pending).toMatchObject({ ok: false, error: { code: "aborted" } });
});
