import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, getOrThrow } from "@earendil-works/pi-agent-core";
import { SessionFileSystem, privateSessionFileSystem } from "../src/platform/sessionFileSystem";
import { sessionFileSystemFixture } from "./sessionFileSystem.fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanups.splice(0)) await fn();
});
async function setup() {
  const fixture = await sessionFileSystemFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}

test("appends UTF-8 bytes, overwrites shorter content, and replaces a sibling destination", async () => {
  const { adapter } = await setup();
  getOrThrow(await adapter.writeFile("/sessions/chat.jsonl", "hello 👋\n", context));
  getOrThrow(
    await adapter.appendFile("/sessions/chat.jsonl", new TextEncoder().encode("世界\n"), context),
  );
  expect(getOrThrow(await adapter.readTextFile("/sessions/chat.jsonl", context))).toBe(
    "hello 👋\n世界\n",
  );
  getOrThrow(await adapter.writeFile("/sessions/chat.jsonl.tmp", "ok\n", context));
  getOrThrow(await adapter.renameFile("/sessions/chat.jsonl.tmp", "/sessions/chat.jsonl", context));
  expect(getOrThrow(await adapter.readTextFile("/sessions/chat.jsonl", context))).toBe("ok\n");
  expect(getOrThrow(await adapter.exists("/sessions/chat.jsonl.tmp", context))).toBe(false);
  getOrThrow(await adapter.writeFile("/sessions/chat.jsonl", "x", context));
  expect(getOrThrow(await adapter.readTextFile("/sessions/chat.jsonl", context))).toBe("x");
});

test("rejects paths outside its private namespace and cross-directory rename", async () => {
  const { adapter } = await setup();
  for (const path of ["../../secret", "file:///secret", "a\\b", "bad\0name"])
    expect((await adapter.writeFile(path, "bad", context)).ok).toBe(false);
  expect((await adapter.renameFile("/one/a", "/two/a", context)).ok).toBe(false);
});

test("propagates append errors and leaves the original intact when rename fails", async () => {
  const { adapter, host, uri } = await setup();
  getOrThrow(await adapter.writeFile("/chat.jsonl", "original\n", context));
  const failingHost = ((path: string) => ({
    ...host(path),
    renameTo: async () => {
      throw new Error("rename failed");
    },
  })) as Acode.FS;
  const failing = new SessionFileSystem(uri, failingHost, async () => {
    throw new Error("disk full");
  });
  expect((await failing.appendFile("/chat.jsonl", "new", context)).ok).toBe(false);
  getOrThrow(await failing.writeFile("/chat.jsonl.tmp", "replacement", context));
  expect((await failing.renameFile("/chat.jsonl.tmp", "/chat.jsonl", context)).ok).toBe(false);
  expect(getOrThrow(await adapter.readTextFile("/chat.jsonl", context))).toBe("original\n");
});

test("uses internal dataDirectory even when DATA_STORAGE points outside it", () => {
  vi.stubGlobal("cordova", { file: { dataDirectory: "file:///private/" } });
  vi.stubGlobal("DATA_STORAGE", "file:///external/");
  vi.stubGlobal("acode", { fsOperation: vi.fn() });
  expect(privateSessionFileSystem().rootUri).toBe("file:///private/ai-agent");
});

test("Cordova append seeks to byte length and rejects writer failure", async () => {
  const { host, uri } = await setup();
  const writer = {
    length: 7,
    seek: vi.fn(),
    write: vi.fn(),
    onwriteend: undefined as (() => void) | undefined,
    onerror: undefined as ((event: unknown) => void) | undefined,
  };
  vi.stubGlobal("resolveLocalFileSystemURL", (_uri: string, success: (entry: unknown) => void) =>
    success({ createWriter: (ready: (writer: unknown) => void) => ready(writer) }),
  );
  writer.write.mockImplementation(() => writer.onwriteend?.());
  const adapter = new SessionFileSystem(uri, host);
  getOrThrow(await adapter.appendFile("/test", "👋", context));
  expect(writer.seek).toHaveBeenCalledWith(7);
  expect(new Uint8Array(writer.write.mock.calls[0][0])).toEqual(new TextEncoder().encode("👋"));
  writer.write.mockImplementation(() => {
    writer.onerror?.({ target: { error: new Error("full") } });
    writer.onwriteend?.();
  });
  expect((await adapter.appendFile("/test", "x", context)).ok).toBe(false);
});

test.each([
  1700000000000,
  "1700000000000",
  new Date(1700000000000),
  "2023-11-14T22:13:20.000Z",
  "invalid",
  null,
])("normalizes host file date %s", async (modifiedDate) => {
  const { host, uri, adapter } = await setup();
  getOrThrow(await adapter.writeFile("/chat.jsonl", "test", context));
  const datedHost = ((path: string) => ({
    ...host(path),
    stat: async () => ({ ...(await host(path).stat()), modifiedDate }),
  })) as unknown as Acode.FS;
  const dated = new SessionFileSystem(uri, datedHost);
  expect(getOrThrow(await dated.fileInfo("/chat.jsonl", context)).mtimeMs).toBe(
    modifiedDate === "invalid" || modifiedDate === null ? 0 : 1700000000000,
  );
});
