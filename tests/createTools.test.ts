import { afterEach, expect, test, vi } from "vitest";
import { createWorkspaceTools } from "../src/tools/createTools.ts";
import type { AcodeWorkspace, FileEntry } from "../src/workspace/acodeWorkspace.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

test("grep treats the query as a case-insensitive regular expression when requested", async () => {
	const workspace = fakeWorkspace({
		"src/main.ts": "const alpha = 1;\nLET beta = 2;\nconsole.log(alpha);",
	});
	const grep = createWorkspaceTools(workspace, { maxWalkFiles: () => 100 }).find((tool) => tool.name === "grep")!;

	const output = await grep.execute("grep-1", { query: "^(const|let)\\s+\\w+", regex: true });

	expect(output.content[0]).toEqual({
		type: "text",
		text: "src/main.ts:1: const alpha = 1;\nsrc/main.ts:2: LET beta = 2;",
	});
});

test("grep applies case sensitivity to regular expressions", async () => {
	const workspace = fakeWorkspace({ "main.ts": "const lower = 1;\nCONST upper = 2;" });
	const grep = createWorkspaceTools(workspace, { maxWalkFiles: () => 100 }).find((tool) => tool.name === "grep")!;

	const output = await grep.execute("grep-2", { query: "^const", regex: true, case_sensitive: true });

	expect(output.content[0]).toEqual({ type: "text", text: "main.ts:1: const lower = 1;" });
});

test("grep keeps regular-expression characters literal by default", async () => {
	const workspace = fakeWorkspace({ "values.txt": "a.b\naxb" });
	const grep = createWorkspaceTools(workspace, { maxWalkFiles: () => 100 }).find((tool) => tool.name === "grep")!;

	const output = await grep.execute("grep-3", { query: "a.b" });

	expect(output.content[0]).toEqual({ type: "text", text: "values.txt:1: a.b" });
});

test("grep reports invalid regular expressions before searching", async () => {
	const workspace = fakeWorkspace({ "main.ts": "anything" });
	const grep = createWorkspaceTools(workspace, { maxWalkFiles: () => 100 }).find((tool) => tool.name === "grep")!;

	await expect(grep.execute("grep-4", { query: "[", regex: true })).rejects.toThrow("Invalid regular expression");
});

test("grep forwards regular-expression mode to Acode's native file index", async () => {
	let searchOptions: Acode.FileIndexSearchOptions | undefined;
	const fileIndex = {
		supports: () => true,
		search: (options: Acode.FileIndexSearchOptions) => {
			searchOptions = options;
			return {
				id: "search-1",
				result: Promise.resolve({ type: "done-searching", files: 1 }),
				cancel: () => Promise.resolve(),
			};
		},
	};
	vi.stubGlobal("acode", { require: (name: string) => name === "fileIndex" ? fileIndex : undefined });
	const workspace = fakeWorkspace({}, false);
	const grep = createWorkspaceTools(workspace, { maxWalkFiles: () => 100 }).find((tool) => tool.name === "grep")!;

	await grep.execute("grep-5", { query: "TODO|FIXME", regex: true, case_sensitive: true });

	expect(searchOptions?.options).toMatchObject({ regExp: true, caseSensitive: true });
});

test("read_file returns PNG content through Pi's image processor contract", async () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const workspace = fakeWorkspace({ "shots/home.png": "not used" }, true, { "shots/home.png": png });
	const imageProcessor = vi.fn(async () => ({
		ok: true as const,
		data: "processed-png",
		mimeType: "image/png",
		hints: ["[Image resized for inline display.]"],
	}));
	const read = createWorkspaceTools(workspace, {
		maxWalkFiles: () => 100,
		autoResizeImages: () => false,
		imageProcessor,
	}).find((tool) => tool.name === "read_file")!;

	const output = await read.execute("read-1", { path: "shots/home.png" });

	expect(imageProcessor).toHaveBeenCalledWith(png, "image/png", { autoResizeImages: false });
	expect(output.content).toEqual([
		{ type: "text", text: "Read image file [image/png]\n[Image resized for inline display.]" },
		{ type: "image", data: "processed-png", mimeType: "image/png" },
	]);
	expect(output.details).toEqual({ operation: "read", path: "shots/home.png" });
});

test("read_file falls back to text when a .png file has no image signature", async () => {
	const workspace = fakeWorkspace({ "notes.png": "plain text despite its suffix" }, true, {
		"notes.png": new TextEncoder().encode("plain text despite its suffix"),
	});
	const read = createWorkspaceTools(workspace, { maxWalkFiles: () => 100 }).find((tool) => tool.name === "read_file")!;

	const output = await read.execute("read-2", { path: "notes.png" });

	expect(output.content[0]).toEqual({ type: "text", text: "plain text despite its suffix" });
});

test("read_file reports an image processor omission without returning invalid image content", async () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const workspace = fakeWorkspace({}, true, { "broken.png": png });
	const read = createWorkspaceTools(workspace, {
		maxWalkFiles: () => 100,
		imageProcessor: async () => ({ ok: false, message: "[Image omitted: decode failed.]" }),
	}).find((tool) => tool.name === "read_file")!;

	const output = await read.execute("read-3", { path: "broken.png" });

	expect(output.content).toEqual([
		{ type: "text", text: "Read image file [image/png]\n[Image omitted: decode failed.]" },
	]);
});

function fakeWorkspace(files: Record<string, string>, remote = true, binaryFiles: Record<string, Uint8Array> = {}): AcodeWorkspace {
	return {
		info: { id: "workspace", name: "project", rootUri: remote ? "sftp://workspace/project" : "file:///project", scheme: remote ? "sftp" : "file", remote },
		sandbox: { normalize: (path: string) => path },
		readText: async (path: string) => files[path],
		readBinary: async (path: string) => binaryFiles[path] ?? new TextEncoder().encode(files[path] ?? ""),
		walk: async (options: { onEntry: (entry: FileEntry) => boolean | void | Promise<boolean | void> }) => {
			let visited = 0;
			for (const path of Object.keys(files)) {
				visited += 1;
				const stop = await options.onEntry({ path, name: path.split("/").at(-1)!, isFile: true, isDirectory: false });
				if (stop) return { visited, truncated: visited < Object.keys(files).length };
			}
			return { visited, truncated: false };
		},
	} as unknown as AcodeWorkspace;
}
