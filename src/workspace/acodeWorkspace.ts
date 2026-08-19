import type { WorkspaceInfo } from "../core/types";
import { PathSandbox, sameParentUri, workspaceId, workspaceRelativeFromIndex } from "./pathSandbox";

export { getAvailableWorkspaces } from "./sidebarFolders";

export type FileEntry = {
	path: string;
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	size?: number;
};

export class AcodeWorkspace {
	readonly info: WorkspaceInfo;
	readonly sandbox: PathSandbox;
	#fileLocks = new Map<string, Promise<unknown>>();

	constructor(rootUri: string, name: string) {
		const scheme = /^([a-z][a-z\d+.-]*):/i.exec(rootUri)?.[1]?.toLowerCase() ?? "file";
		this.info = {
			id: workspaceId(rootUri),
			name,
			rootUri,
			scheme,
			remote: scheme === "ftp" || scheme === "sftp",
		};
		this.sandbox = new PathSandbox(rootUri, (root, path) => acode.joinUrl(root, path));
	}

	async readText(path: string): Promise<string> {
		const { uri } = this.sandbox.resolve(path);
		const openFile = editorManager.getFile(uri, "uri");
		if (openFile?.loaded) return openFile.session.getValue();
		return acode.fsOperation(uri).readFile("utf-8");
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const { uri } = this.sandbox.resolve(path);
		const buffer = await acode.fsOperation(uri).readFile();
		return new Uint8Array(buffer);
	}

	async writeText(path: string, content: string): Promise<"buffer" | "disk"> {
		const { relativePath, uri } = this.sandbox.resolve(path);
		if (!relativePath) throw new Error("A file path is required.");
		return this.#serialize(uri, async () => {
			const openFile = editorManager.getFile(uri, "uri");
			if (openFile?.loaded) {
				if (openFile.readOnly) throw new Error(`${relativePath} is read-only.`);
				if (editorManager.activeFile?.id === openFile.id) {
					const editor = editorManager.editor;
					editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } });
				} else {
					openFile.session.setValue(content);
				}
				openFile.isUnsaved = true;
				openFile.markChanged = true;
				editorManager.emit("file-content-changed", openFile);
				return "buffer";
			}

			const target = acode.fsOperation(uri);
			if (await target.exists()) {
				await target.writeFile(content);
			} else {
				const slash = relativePath.lastIndexOf("/");
				const parentPath = slash >= 0 ? relativePath.slice(0, slash) : "";
				const filename = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
				await this.#ensureDirectory(parentPath);
				const parent = this.sandbox.resolve(parentPath).uri;
				await acode.fsOperation(parent).createFile(filename, content);
			}
			return "disk";
		});
	}

	async list(path = ""): Promise<FileEntry[]> {
		const base = this.sandbox.resolve(path);
		const indexed = await this.#listIndexedChildren(base.uri);
		if (indexed) return indexed;
		return this.#listViaFs(base);
	}

	async stat(path: string): Promise<Acode.Stat> {
		return acode.fsOperation(this.sandbox.resolve(path).uri).stat();
	}

	async walk(options: {
		path?: string;
		maxFiles: number;
		maxDepth?: number;
		signal?: AbortSignal;
		onEntry: (entry: FileEntry) => boolean | void | Promise<boolean | void>;
	}): Promise<{ visited: number; truncated: boolean }> {
		const indexed = await this.#walkIndexed(options);
		if (indexed && indexed.visited > 0) return indexed;

		const queue = [{ path: options.path ?? "", depth: 0 }];
		const maxDepth = options.maxDepth ?? 16;
		let visited = 0;
		while (queue.length && visited < options.maxFiles) {
			if (options.signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
			const current = queue.shift()!;
			let entries: FileEntry[];
			try {
				entries = await this.#listViaFs(this.sandbox.resolve(current.path));
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (isIgnored(entry.path)) continue;
				if (entry.isDirectory && current.depth < maxDepth) {
					queue.push({ path: entry.path, depth: current.depth + 1 });
				}
				if (!entry.isFile) continue;
				visited += 1;
				const shouldStop = await options.onEntry(entry);
				if (shouldStop || visited >= options.maxFiles) {
					return { visited, truncated: queue.length > 0 || visited >= options.maxFiles };
				}
			}
		}
		return { visited, truncated: queue.length > 0 };
	}

	async #listViaFs(base: { relativePath: string; uri: string }): Promise<FileEntry[]> {
		const fs = acode.fsOperation(base.uri);
		if (!fs || typeof fs.lsDir !== "function") {
			throw new Error(`Cannot list ${base.relativePath || "the workspace"}.`);
		}
		try {
			const entries = await fs.lsDir();
			return entries.map((entry) => ({
				path: [base.relativePath, entry.name].filter(Boolean).join("/"),
				name: entry.name,
				isFile: entry.isFile,
				isDirectory: entry.isDirectory,
			}));
		} catch (error) {
			if (!isMissingDirectoryReader(error)) throw error;
			const indexed = await this.#listIndexedChildren(base.uri, true);
			if (indexed) return indexed;
			throw new Error(`Cannot list ${base.relativePath || "the workspace"} with Acode's folder APIs.`);
		}
	}

	async #listIndexedChildren(parentUri: string, rescan = false): Promise<FileEntry[] | undefined> {
		const index = nativeFileIndex();
		if (!index?.supports(this.info.rootUri)) return undefined;
		if (rescan) await index.scan({ url: this.info.rootUri, name: this.info.name }).catch(() => undefined);
		await index.whenReady([this.info.rootUri]);
		const entries = await queryIndexedFiles(index, this.info.rootUri, true);
		if (!entries.length && !rescan) return this.#listIndexedChildren(parentUri, true);
		return entries
			.filter((entry) => sameParentUri(entry.parentUrl || entry.parent, parentUri))
			.map((entry) => this.#fromIndex(entry));
	}

	async #walkIndexed(options: {
		path?: string;
		maxFiles: number;
		signal?: AbortSignal;
		onEntry: (entry: FileEntry) => boolean | void | Promise<boolean | void>;
	}): Promise<{ visited: number; truncated: boolean } | undefined> {
		const index = nativeFileIndex();
		if (!index?.supports(this.info.rootUri)) return undefined;
		await index.whenReady([this.info.rootUri]);
		const prefix = options.path ?? "";
		let files = await queryIndexedFiles(index, this.info.rootUri, false);
		if (!files.length) {
			await index.scan({ url: this.info.rootUri, name: this.info.name }).catch(() => undefined);
			await index.whenReady([this.info.rootUri]);
			files = await queryIndexedFiles(index, this.info.rootUri, false);
		}
		if (!files.length) return undefined;
		let visited = 0;
		for (const item of files) {
			if (options.signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
			const entry = this.#fromIndex(item);
			if (!entry.isFile || isIgnored(entry.path)) continue;
			if (prefix && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) continue;
			visited += 1;
			const shouldStop = await options.onEntry(entry);
			if (shouldStop || visited >= options.maxFiles) {
				return { visited, truncated: files.length > visited };
			}
		}
		return { visited, truncated: false };
	}

	#fromIndex(entry: Acode.FileIndexEntry): FileEntry {
		return {
			path: workspaceRelativeFromIndex(entry, this.sandbox, this.info.name),
			name: entry.name,
			isFile: entry.isFile,
			isDirectory: entry.isDirectory,
			size: entry.size,
		};
	}

	#serialize<T>(uri: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#fileLocks.get(uri) ?? Promise.resolve();
		const current = previous.then(task, task);
		this.#fileLocks.set(uri, current.catch(() => undefined));
		return current;
	}

	async #ensureDirectory(relativePath: string): Promise<void> {
		if (!relativePath) return;
		let current = "";
		for (const segment of this.sandbox.normalize(relativePath).split("/")) {
			const parentUri = this.sandbox.resolve(current).uri;
			current = [current, segment].filter(Boolean).join("/");
			const directory = acode.fsOperation(this.sandbox.resolve(current).uri);
			if (!(await directory.exists())) await acode.fsOperation(parentUri).createDirectory(segment);
		}
	}
}

function nativeFileIndex(): Acode.FileIndex | undefined {
	try {
		const index = acode.require("fileIndex");
		return index && typeof index.query === "function" ? index : undefined;
	} catch {
		return undefined;
	}
}

async function queryIndexedFiles(index: Acode.FileIndex, rootUri: string, includeDirectories: boolean): Promise<Acode.FileIndexEntry[]> {
	const entries: Acode.FileIndexEntry[] = [];
	let cursor = 0;
	for (let page = 0; page < 20; page += 1) {
		const result = await index.query({
			roots: [rootUri],
			includeDirectories,
			limit: 200,
			cursor,
		});
		entries.push(...(result.entries ?? []));
		if (!result.hasMore || result.cursor == null) break;
		cursor = result.cursor;
	}
	return entries;
}

function isMissingDirectoryReader(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /createReader is not a function/i.test(message);
}

function isIgnored(path: string): boolean {
	return path.split("/").some((part) =>
		[".git", "node_modules", "dist", "build", ".next", ".cache"].includes(part),
	);
}
