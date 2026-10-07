import "fake-indexeddb/auto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { IdbFileSystem, openAgentDatabase } from "../src/platform/idbFileSystem";

let databases = 0;
function freshFs(): IdbFileSystem {
  databases += 1;
  return new IdbFileSystem(openAgentDatabase(`test-${databases}`));
}

describe("IdbFileSystem", () => {
  it("appends, merges chunks on read, truncates, and renames", async () => {
    const fs = freshFs();
    getOrThrow(await fs.createDir("/a/b", { recursive: true }, context));
    getOrThrow(await fs.appendFile("/a/b/log.jsonl", "one\n", context));
    getOrThrow(await fs.appendFile("/a/b/log.jsonl", "two\n", context));
    expect(getOrThrow(await fs.readTextFile("/a/b/log.jsonl", context))).toBe("one\ntwo\n");
    getOrThrow(await fs.appendFile("/a/b/log.jsonl", "thr", context));
    getOrThrow(await fs.truncateFile("/a/b/log.jsonl", 8, context));
    expect(getOrThrow(await fs.readTextFile("/a/b/log.jsonl", context))).toBe("one\ntwo\n");
    getOrThrow(await fs.writeFile("/a/b/tmp", "x", context));
    getOrThrow(await fs.renameFile("/a/b/tmp", "/a/b/final", context));
    expect(getOrThrow(await fs.exists("/a/b/tmp", context))).toBe(false);
    expect(getOrThrow(await fs.readTextFile("/a/b/final", context))).toBe("x");
    const listed = getOrThrow(await fs.listDir("/a/b", context));
    expect(listed.map((item) => item.name).sort()).toEqual(["final", "log.jsonl"]);
    expect(getOrThrow(await fs.fileInfo("/a/b/log.jsonl", context)).size).toBe(8);
  });

  it("refuses writes without a parent and removes trees", async () => {
    const fs = freshFs();
    const missing = await fs.appendFile("/nope/file", "x", context);
    expect(missing.ok ? undefined : missing.error.code).toBe("not_found");
    getOrThrow(await fs.createDir("/chats/one", { recursive: true }, context));
    getOrThrow(await fs.writeFile("/chats/one/main.jsonl", "a\n", context));
    getOrThrow(await fs.createDir("/chats/two", { recursive: true }, context));
    const notEmpty = await fs.remove("/chats/one", undefined, context);
    expect(notEmpty.ok ? undefined : notEmpty.error.code).toBe("invalid");
    getOrThrow(await fs.remove("/chats/one", { recursive: true }, context));
    expect(getOrThrow(await fs.exists("/chats/one/main.jsonl", context))).toBe(false);
    expect(getOrThrow(await fs.listDir("/chats", context)).map((item) => item.name)).toEqual([
      "two",
    ]);
    getOrThrow(await fs.remove("/chats/one", { force: true }, context));
  });

  it("rejects paths that escape the root", async () => {
    const fs = freshFs();
    const escaped = await fs.absolutePath("/../x", context);
    expect(escaped.ok).toBe(false);
  });
});

let storages = 0;
registerStorageConformance({ describe, expect, it }, "JsonlStorage on IndexedDB", async (use) => {
  storages += 1;
  const storage = await JsonlStorage.open(`/chats/c${storages}`, freshFs(), context);
  try {
    await use(storage);
  } finally {
    await storage.close(context).catch(() => undefined);
  }
});
