import { afterEach, expect, test, vi } from "vitest";
import {
	createHomeProject,
	formatPlatformError,
	randomProjectName,
	terminalHomeUrl,
} from "../src/platform/randomProject.ts";

afterEach(() => vi.unstubAllGlobals());

test("builds safe random project names", () => {
	const values = [0, 0.5, 0.999];
	let index = 0;
	expect(randomProjectName(() => values[index++]!)).toBe("amber-kite-99");
});

test("clamps invalid random sources", () => {
	expect(randomProjectName(() => Number.NaN)).toBe("amber-atlas-10");
	expect(randomProjectName(() => 4)).toBe("swift-studio-99");
});

test("resolves terminal home from BuildInfo package name", async () => {
	vi.stubGlobal("BuildInfo", { packageName: "com.foxdebug.acodefree" });
	expect(await terminalHomeUrl()).toBe("file:///data/user/0/com.foxdebug.acodefree/files/public/");
});

test("falls back to default terminal home URL if no provider is present", async () => {
	expect(await terminalHomeUrl()).toBe("file:///data/user/0/com.foxdebug.acode/files/public/");
});

test("resolves terminal home using system.getFilesDir when available", async () => {
	vi.stubGlobal("system", {
		getFilesDir: (success: (dir: string) => void) => success("/data/user/0/com.foxdebug.acode/files"),
	});
	vi.stubGlobal("acode", {
		require: () => undefined,
		joinUrl: (root: string, path: string) => `${root.replace(/\/+$/, "")}/${path}`,
	});
	const home = await terminalHomeUrl();
	expect(home).toBe("file:///data/user/0/com.foxdebug.acode/files/public");
});

test("creates with fs and adds the computed full URL through openFolder", async () => {
	const listeners = new Map<string, Set<() => void>>();
	const manager = {
		on(event: string, listener: () => void) {
			const entries = listeners.get(event) ?? new Set();
			entries.add(listener);
			listeners.set(event, entries);
		},
		off(event: string, listener: () => void) { listeners.get(event)?.delete(listener); },
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
		require: (name: string) => name.toLowerCase() === "fs"
			? fs
			: name.toLowerCase() === "openfolder"
				? openFolder
				: name.toLowerCase() === "addedfolder"
					? folders
					: undefined,
	});

	const workspace = await createHomeProject("amber-kite-99");
	expect(fs).toHaveBeenCalledWith("file:///data/user/0/com.foxdebug.acode/files/public/");
	expect(createDirectory).toHaveBeenCalledWith("amber-kite-99");
	expect(openFolder).toHaveBeenCalledWith(
		"file:///data/user/0/com.foxdebug.acode/files/public/amber-kite-99",
		{ name: "amber-kite-99", saveState: true },
	);
	expect(workspace).toMatchObject({ id: expect.any(String), name: "amber-kite-99" });
});

test("formats errors nicely", () => {
	vi.stubGlobal("acode", {
		require: (name: string) => name === "helpers" ? { errorMessage: (err: { message?: string }) => err.message } : undefined,
	});
	expect(formatPlatformError(new Error("Disk error"))).toBe("Disk error");
	expect(formatPlatformError({ message: "parent is missing" })).toBe("parent is missing");
});
