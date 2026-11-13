import { afterEach, expect, test, vi } from "vitest";
import {
  createHomeProject,
  formatPlatformError,
  promptProjectName,
  randomProjectName,
  terminalFilesUrl,
} from "../src/platform/randomProject.ts";

afterEach(() => vi.unstubAllGlobals());

test("builds safe random project names", () => {
  const values = [0, 0.5, 0.999];
  let index = 0;
  expect(randomProjectName(() => values[index++]!)).toBe("amber-kite-99");
});

test("prefills an editable project name and leaves cancellation to the caller", async () => {
  const prompt = vi.fn(
    async (
      _title: string,
      suggestion: string,
      _type: string,
      options: { test(name: string): boolean },
    ) => {
      expect(options.test(suggestion)).toBe(true);
      expect(options.test("My notes")).toBe(true);
      for (const name of [
        "../notes",
        "Demo: v2",
        "app" + String.fromCharCode(127),
        "é".repeat(128),
      ]) {
        expect(options.test(name)).toBe(false);
      }
      for (const name of [".notes", "notes.", "é".repeat(127) + "a"]) {
        expect(options.test(name)).toBe(true);
      }
      return null;
    },
  );
  vi.stubGlobal("acode", { prompt, require: () => ({}) });
  expect(await promptProjectName()).toBeNull();
  expect(prompt.mock.calls[0]?.[1]).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
});

test("rejects unsafe and existing names before creating or opening a folder", async () => {
  const createDirectory = vi.fn();
  const openFolder = vi.fn();
  const fs = vi.fn(() => ({ exists: async () => true, createDirectory }));
  vi.stubGlobal("acode", {
    joinUrl: (root: string, name: string) => root + name,
    require: (name: string) => (name === "fs" ? fs : openFolder),
  });
  await expect(createHomeProject("..")).rejects.toThrow("valid project folder name");
  expect(fs).not.toHaveBeenCalled();
  await expect(createHomeProject("Existing")).rejects.toThrow("already exists");
  expect(createDirectory).not.toHaveBeenCalled();
  expect(openFolder).not.toHaveBeenCalled();
});

test("clamps invalid random sources", () => {
  expect(randomProjectName(() => Number.NaN)).toBe("amber-atlas-10");
  expect(randomProjectName(() => 4)).toBe("swift-studio-99");
});

test("resolves terminal files directory from BuildInfo package name", async () => {
  vi.stubGlobal("BuildInfo", { packageName: "com.foxdebug.acodefree" });
  expect(await terminalFilesUrl()).toBe("file:///data/user/0/com.foxdebug.acodefree/files");
});

test("falls back to default files directory URL if no provider is present", async () => {
  expect(await terminalFilesUrl()).toBe("file:///data/user/0/com.foxdebug.acode/files");
});

test("resolves terminal files directory using system.getFilesDir when available", async () => {
  vi.stubGlobal("system", {
    getFilesDir: (success: (dir: string) => void) =>
      success("/data/user/0/com.foxdebug.acode/files"),
  });
  vi.stubGlobal("acode", {
    require: () => undefined,
    joinUrl: (root: string, path: string) => `${root.replace(/\/+$/, "")}/${path}`,
  });
  expect(await terminalFilesUrl()).toBe("file:///data/user/0/com.foxdebug.acode/files");
});

test("creates with fs and adds the computed full URL through openFolder", async () => {
  const listeners = new Map<string, Set<() => void>>();
  const manager = {
    on(event: string, listener: () => void) {
      const entries = listeners.get(event) ?? new Set();
      entries.add(listener);
      listeners.set(event, entries);
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const folders: Array<{ id: string; url: string; title: string }> = [];
  const createDirectory = vi.fn(async () => undefined);
  const fs = vi.fn(() => ({ createDirectory, exists: vi.fn(async () => false) }));
  const openFolder = vi.fn((url: string, options: { name: string }) => {
    folders.push({ id: "home-project", url, title: options.name });
    for (const listener of listeners.get("add-folder") ?? []) listener();
  });
  vi.stubGlobal("BuildInfo", { packageName: "com.foxdebug.acode" });
  vi.stubGlobal("window", { editorManager: manager });
  vi.stubGlobal("acode", {
    joinUrl: (root: string, path: string) => `${root.replace(/\/+$/, "")}/${path}`,
    require: (name: string) =>
      name.toLowerCase() === "fs"
        ? fs
        : name.toLowerCase() === "openfolder"
          ? openFolder
          : name.toLowerCase() === "addedfolder"
            ? folders
            : undefined,
  });

  const workspace = await createHomeProject("  My notes  ");
  expect(fs.mock.calls).toEqual([
    ["file:///data/user/0/com.foxdebug.acode/files/public"],
    ["file:///data/user/0/com.foxdebug.acode/files"],
    ["file:///data/user/0/com.foxdebug.acode/files/public/My notes"],
  ]);
  expect(createDirectory.mock.calls).toEqual([["public"], ["My notes"]]);
  expect(openFolder).toHaveBeenCalledWith(
    "file:///data/user/0/com.foxdebug.acode/files/public/My notes",
    { name: "My notes", saveState: true },
  );
  expect(workspace).toMatchObject({ id: expect.any(String), name: "My notes" });
});

test("formats errors nicely", () => {
  vi.stubGlobal("acode", {
    require: (name: string) =>
      name === "helpers" ? { errorMessage: (err: { message?: string }) => err.message } : undefined,
  });
  expect(formatPlatformError(new Error("Disk error"))).toBe("Disk error");
  expect(formatPlatformError({ message: "parent is missing" })).toBe("parent is missing");
});
