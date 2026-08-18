import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AcodeWorkspace, FileEntry } from "../workspace/acodeWorkspace";
import { workspaceRelativeFromIndex } from "../workspace/pathSandbox";
import { globMatcher } from "./glob";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, selectReadOutput } from "./truncate";
import { applyExactEdit } from "./textEdits";

type ToolDetails = {
	path?: string;
	operation: string;
	target?: "buffer" | "disk";
	count?: number;
	truncated?: boolean;
};

type ToolResult = AgentToolResult<ToolDetails>;

export function createWorkspaceTools(
	workspace: AcodeWorkspace,
	options: { maxWalkFiles: () => number },
): AgentTool<any>[] {
	const readFile: AgentTool<any> = {
		name: "read_file",
		label: "Read file",
		description:
			`Read a UTF-8 text file. Paths are relative to the active workspace. ` +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. ` +
			`Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: Type.Object({
			path: Type.String({ description: "Workspace-relative file path" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
		}),
		executionMode: workspace.info.remote ? "sequential" : "parallel",
		execute: async (_id, params, signal) => {
			const input = params as { path: string; offset?: number; limit?: number };
			throwIfAborted(signal);
			const path = workspace.sandbox.normalize(input.path);
			const text = await workspace.readText(path);
			assertTextFile(path, text);
			const output = selectReadOutput(text, input.offset, input.limit);
			return result(output.text, { operation: "read", path, truncated: output.truncated });
		},
	};

	const listDir: AgentTool<any> = {
		name: "list_dir",
		label: "List directory",
		description: "List files and folders in a workspace directory.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Workspace-relative directory, empty for root" })),
		}),
		executionMode: workspace.info.remote ? "sequential" : "parallel",
		execute: async (_id, params, signal) => {
			const input = params as { path?: string };
			throwIfAborted(signal);
			const path = workspace.sandbox.normalize(input.path ?? "");
			const entries = await workspace.list(path);
			const text = entries
				.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
				.map((entry) => `${entry.isDirectory ? "d" : "f"}  ${entry.path}`)
				.join("\n");
			return result(text || "Directory is empty.", { operation: "list", path, count: entries.length });
		},
	};

	const grep: AgentTool<any> = {
		name: "grep",
		label: "Search workspace",
		description: "Search text files for a literal string. Returns workspace-relative paths and line numbers.",
		parameters: Type.Object({
			query: Type.String({ description: "Literal text to find" }),
			path: Type.Optional(Type.String({ description: "Directory to search" })),
			case_sensitive: Type.Optional(Type.Boolean({ default: false })),
		}),
		executionMode: workspace.info.remote ? "sequential" : "parallel",
		execute: async (_id, params, signal, onUpdate) => {
			const input = params as { query: string; path?: string; case_sensitive?: boolean };
			const query = String(input.query);
			if (!query) throw new Error("Search query cannot be empty.");
			const path = workspace.sandbox.normalize(input.path ?? "");
			const indexed = await grepViaFileIndex(workspace, query, path, Boolean(input.case_sensitive), signal);
			if (indexed && (indexed.hits.length > 0 || indexed.files > 0)) {
				return result(indexed.hits.join("\n") || `No matches found in ${indexed.files} indexed files.`, {
					operation: "grep",
					count: indexed.hits.length,
					truncated: indexed.hits.length >= 200,
				});
			}
			const needle = input.case_sensitive ? query : query.toLowerCase();
			const hits: string[] = [];
			const walk = await workspace.walk({
				path,
				maxFiles: workspace.info.remote ? Math.min(80, options.maxWalkFiles()) : options.maxWalkFiles(),
				signal,
				onEntry: async (entry) => {
					if (looksBinary(entry.path)) return;
					try {
						const text = await workspace.readText(entry.path);
						assertTextFile(entry.path, text);
						for (const [index, line] of text.split(/\r?\n/).entries()) {
							const haystack = input.case_sensitive ? line : line.toLowerCase();
							if (haystack.includes(needle)) hits.push(`${entry.path}:${index + 1}: ${truncate(line.trim(), 240)}`);
							if (hits.length >= 200) return true;
						}
					} catch {
						// Unreadable/binary files are skipped during bounded search.
					}
					onUpdate?.(result(`Searched ${entry.path}`, { operation: "grep", count: hits.length }));
				},
			});
			return result(hits.join("\n") || `No matches found in ${walk.visited} files.`, {
				operation: "grep",
				count: hits.length,
				truncated: walk.truncated || hits.length >= 200,
			});
		},
	};

	const glob: AgentTool<any> = {
		name: "glob",
		label: "Find files",
		description: "Find files by a glob pattern such as **/*.ts, src/**, or **/*.{md,json,js}.",
		parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
		executionMode: workspace.info.remote ? "sequential" : "parallel",
		execute: async (_id, params, signal) => {
			const input = params as { pattern: string; path?: string };
			const matcher = globMatcher(input.pattern);
			const matches: FileEntry[] = [];
			const walk = await workspace.walk({
				path: workspace.sandbox.normalize(input.path ?? ""),
				maxFiles: options.maxWalkFiles(),
				signal,
				onEntry: (entry) => {
					if (matcher.test(entry.path)) matches.push(entry);
					return matches.length >= 200;
				},
			});
			return result(matches.map((entry) => entry.path).join("\n") || `No files matched ${input.pattern} in ${walk.visited} files.`, {
				operation: "glob",
				count: matches.length,
				truncated: walk.truncated || matches.length >= 200,
			});
		},
	};

	const writeFile: AgentTool<any> = {
		name: "write_file",
		label: "Write file",
		description: "Create or replace a UTF-8 text file. Requires user approval unless session approval is enabled.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const input = params as { path: string; content: string };
			throwIfAborted(signal);
			const path = workspace.sandbox.normalize(input.path);
			assertWritable(path, input.content);
			const target = await workspace.writeText(path, input.content);
			return result(`Updated ${path} in the ${target === "buffer" ? "open editor buffer (not auto-saved)" : "workspace"}.`, {
				operation: "write",
				path,
				target,
			});
		},
	};

	const editFile: AgentTool<any> = {
		name: "edit_file",
		label: "Edit file",
		description: "Replace an exact string in a UTF-8 text file. By default the match must be unique.",
		parameters: Type.Object({
			path: Type.String(),
			old_string: Type.String(),
			new_string: Type.String(),
			replace_all: Type.Optional(Type.Boolean({ default: false })),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const input = params as { path: string; old_string: string; new_string: string; replace_all?: boolean };
			throwIfAborted(signal);
			const path = workspace.sandbox.normalize(input.path);
			const current = await workspace.readText(path);
			assertTextFile(path, current);
			let edit;
			try {
				edit = applyExactEdit(current, input.old_string, input.new_string, input.replace_all);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)} File: ${path}`);
			}
			const next = edit.text;
			assertWritable(path, next);
			const target = await workspace.writeText(path, next);
			return result(`Replaced ${edit.replacements} match${edit.replacements === 1 ? "" : "es"} in ${path}${target === "buffer" ? " (open buffer, not auto-saved)" : ""}.`, {
				operation: "edit",
				path,
				target,
				count: edit.replacements,
			});
		},
	};

	return [readFile, listDir, grep, glob, writeFile, editFile];
}

export { globMatcher } from "./glob";

function result(content: string, details: ToolDetails): ToolResult {
	return { content: [{ type: "text", text: content }], details };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function assertTextFile(path: string, content: string): void {
	if (looksBinary(path) || content.includes("\0")) throw new Error(`${path} appears to be binary.`);
	if (content.length > maxTextCharacters()) throw new Error(`${path} exceeds Acode's configured file-size limit.`);
}

function assertWritable(path: string, content: string): void {
	if (!path) throw new Error("A file path is required.");
	assertTextFile(path, content);
}

function maxTextCharacters(): number {
	try {
		const settings = acode.require("settings") as Acode.Settings;
		return Math.max(1, settings.value.maxFileSize) * 1024 * 1024;
	} catch {
		return 12 * 1024 * 1024;
	}
}

function looksBinary(path: string): boolean {
	return /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|apk|so|wasm|woff2?|ttf|mp[34]|wav|ogg)$/i.test(path);
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function grepViaFileIndex(
	workspace: AcodeWorkspace,
	query: string,
	path: string,
	caseSensitive: boolean,
	signal?: AbortSignal,
): Promise<{ hits: string[]; files: number } | undefined> {
	try {
		const index = acode.require("fileIndex") as Acode.FileIndex | undefined;
		if (!index || typeof index.search !== "function" || !index.supports(workspace.info.rootUri)) return undefined;
		throwIfAborted(signal);
		const hits: string[] = [];
		const seen = new Set<string>();
		const handle = index.search({
			roots: [workspace.info.rootUri],
			search: query,
			options: {
				caseSensitive,
				include: path ? `${path}/**,${path}/*` : undefined,
			},
			overlays: dirtyEditorOverlays(),
			useIndex: false,
		}, (event) => {
			const batches = event.type === "search-results" ? event.data : event.type === "search-result" ? [event.data] : [];
			for (const item of batches) {
				const filePath = filePathFromSearch(item.file, workspace);
				if (path && filePath !== path && !filePath.startsWith(`${path}/`)) continue;
				for (const match of item.matches ?? []) {
					const line = Number(match.position?.start?.line ?? 0) + 1;
					const text = `${filePath}:${line}: ${truncate((match.line || match.renderText || match.match || "").trim(), 240)}`;
					if (seen.has(text)) continue;
					seen.add(text);
					hits.push(text);
					if (hits.length >= 200) return;
				}
			}
		});
		const finished = await handle.result;
		if (signal?.aborted) {
			void handle.cancel().catch(() => undefined);
			throw new DOMException("Operation aborted", "AbortError");
		}
		if (finished.type === "error") return undefined;
		const files = "files" in finished ? Number(finished.files ?? 0) : 0;
		return { hits, files: files || hits.length };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		return undefined;
	}
}

function filePathFromSearch(file: Acode.FileIndexEntry | Record<string, unknown>, workspace: AcodeWorkspace): string {
	const record = file as Partial<Acode.FileIndexEntry>;
	return workspaceRelativeFromIndex(
		{ path: record.path, url: record.url, uri: record.uri, name: record.name },
		workspace.sandbox,
		workspace.info.name,
	);
}

function dirtyEditorOverlays(): Record<string, string> {
	const overlays: Record<string, string> = {};
	try {
		for (const file of editorManager.files ?? []) {
			if (!file?.loaded || !file.uri || !file.session) continue;
			overlays[file.uri] = file.session.getValue();
		}
	} catch {
		// Editor manager is optional in tests and non-Acode hosts.
	}
	return overlays;
}
