import type { AcodeWorkspace } from "./acodeWorkspace";
import { workspaceRelativeFromIndex } from "./pathSandbox";

export type MentionFile = {
	path: string;
	name: string;
	open?: boolean;
};

const FILE_LIST_TTL_MS = 15_000;
const fileListCache = new Map<string, { at: number; files: MentionFile[] }>();

export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | undefined {
	const head = text.slice(0, Math.max(0, caret));
	const match = /(?:^|[\s([{'"])@([^\s@]*)$/.exec(head);
	if (!match) return undefined;
	return { start: head.lastIndexOf("@"), query: match[1] ?? "" };
}

export function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}

export function fileName(path: string): string {
	return path.split("/").filter(Boolean).pop() || path;
}

export function fileDir(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

export function fileExt(path: string): string {
	const name = fileName(path);
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

export function rankMentionFiles(files: MentionFile[], query: string, limit = 24): MentionFile[] {
	const needle = query.trim().toLowerCase();
	const scored = files.flatMap((file) => {
		const name = file.name.toLowerCase();
		const path = file.path.toLowerCase();
		let score = file.open ? 40 : 0;
		if (needle) {
			if (name === needle) score += 120;
			else if (name.startsWith(needle)) score += 90;
			else if (name.includes(needle)) score += 60;
			else if (path.includes(needle)) score += 30;
			else return [];
		}
		score -= Math.min(20, file.path.length / 8);
		return [{ file, score }];
	});
	scored.sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
	const seen = new Set<string>();
	const ranked: MentionFile[] = [];
	for (const item of scored) {
		if (seen.has(item.file.path)) continue;
		seen.add(item.file.path);
		ranked.push(item.file);
		if (ranked.length >= limit) break;
	}
	return ranked;
}

export async function searchWorkspaceFiles(
	workspace: AcodeWorkspace,
	query: string,
	limit = 24,
): Promise<MentionFile[]> {
	const open = openEditorFiles(workspace);
	const indexed = await searchIndexedFiles(workspace, query, limit);
	const listed = indexed.length ? [] : await listRemoteFiles(workspace);
	return rankMentionFiles([...open, ...indexed, ...listed], query, limit);
}

function openEditorFiles(workspace: AcodeWorkspace): MentionFile[] {
	try {
		return (editorManager.files ?? []).flatMap((file) => {
			if (!file?.uri || (file.type && file.type !== "editor")) return [];
			const path = workspace.sandbox.relative(file.uri);
			if (path === undefined || path === "") return [];
			return [{ path, name: file.filename || fileName(path), open: true }];
		});
	} catch {
		return [];
	}
}

async function searchIndexedFiles(workspace: AcodeWorkspace, query: string, limit: number): Promise<MentionFile[]> {
	try {
		const index = acode.require("fileIndex") as Acode.FileIndex | undefined;
		if (!index?.supports(workspace.info.rootUri)) return [];
		await index.whenReady([workspace.info.rootUri]).catch(() => undefined);
		const result = await index.query({
			roots: [workspace.info.rootUri],
			text: query.trim() || undefined,
			includeDirectories: false,
			limit: Math.min(200, Math.max(limit * 4, 40)),
		});
		return (result.entries ?? []).flatMap((entry) => {
			if (entry.isDirectory) return [];
			const path = workspaceRelativeFromIndex(entry, workspace.sandbox, workspace.info.name);
			if (!path) return [];
			return [{ path, name: entry.name || fileName(path) }];
		});
	} catch {
		return [];
	}
}

async function listRemoteFiles(workspace: AcodeWorkspace): Promise<MentionFile[]> {
	const cached = fileListCache.get(workspace.info.id);
	if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
	try {
		const fileList = acode.require("fileList") as Acode.FileList | undefined;
		if (!fileList) return [];
		const trees = fileList();
		if (!Array.isArray(trees)) return [];
		const files: MentionFile[] = [];
		for (const tree of trees) walkTree(tree, workspace, files);
		fileListCache.set(workspace.info.id, { at: Date.now(), files });
		return files;
	} catch {
		return [];
	}
}

function walkTree(tree: Acode.Tree, workspace: AcodeWorkspace, files: MentionFile[]): void {
	if (tree.children?.length) {
		for (const child of tree.children) walkTree(child, workspace, files);
		return;
	}
	if (tree.children) return;
	const path = workspace.sandbox.relative(tree.url)
		?? workspaceRelativeFromIndex(tree, workspace.sandbox, workspace.info.name);
	if (!path) return;
	files.push({ path, name: tree.name || fileName(path) });
}
