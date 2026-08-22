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

function fakeWorkspace(files: Record<string, string>, remote = true): AcodeWorkspace {
	return {
		info: { id: "workspace", name: "project", rootUri: remote ? "sftp://workspace/project" : "file:///project", scheme: remote ? "sftp" : "file", remote },
		sandbox: { normalize: (path: string) => path },
		readText: async (path: string) => files[path],
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
