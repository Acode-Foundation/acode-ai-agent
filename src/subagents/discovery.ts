import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { parseAgentMarkdown, toDefinition } from "./frontmatter";
import type { SubagentDefinition, SubagentScope } from "./types";

const PROJECT_ROOTS = [".pi/agents", ".agents"];
const MAX_AGENT_FILES = 80;

export async function discoverProjectAgents(workspace: AcodeWorkspace): Promise<SubagentDefinition[]> {
	const found: SubagentDefinition[] = [];
	const seen = new Set<string>();
	for (const root of PROJECT_ROOTS) {
		const files = await listMarkdown(workspace, root);
		for (const path of files) {
			if (path.endsWith(".chain.md") || path.endsWith("/SKILL.md")) continue;
			try {
				const parsed = parseAgentMarkdown(await workspace.readText(path), fileStem(path));
				if (seen.has(parsed.name)) continue;
				seen.add(parsed.name);
				found.push(toDefinition(parsed, "project", path));
			} catch (error) {
				console.warn(`AI subagent ignored: ${path}`, error);
			}
		}
	}
	return found;
}

export async function discoverUserAgents(): Promise<SubagentDefinition[]> {
	const storage = (globalThis as { DATA_STORAGE?: string }).DATA_STORAGE;
	if (!storage) return [];
	const roots = [
		joinUri(storage, ".pi/agent/agents"),
		joinUri(storage, ".agents"),
	];
	const found: SubagentDefinition[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		let entries: Array<{ name: string; url?: string; isFile: boolean; isDirectory: boolean }>;
		try {
			entries = await acode.fsOperation(root).lsDir();
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile || !/\.md$/i.test(entry.name) || entry.name.endsWith(".chain.md")) continue;
			const path = entry.url || joinUri(root, entry.name);
			try {
				const parsed = parseAgentMarkdown(await acode.fsOperation(path).readFile("utf-8"), fileStem(entry.name));
				if (seen.has(parsed.name)) continue;
				seen.add(parsed.name);
				found.push(toDefinition(parsed, "user", path));
			} catch (error) {
				console.warn(`AI subagent ignored: ${path}`, error);
			}
		}
	}
	return found;
}

async function listMarkdown(workspace: AcodeWorkspace, root: string): Promise<string[]> {
	const paths: string[] = [];
	try {
		await workspace.walk({
			path: root,
			maxFiles: MAX_AGENT_FILES,
			onEntry(entry) {
				if (entry.isFile && /\.md$/i.test(entry.name)) paths.push(entry.path);
				return paths.length >= MAX_AGENT_FILES;
			},
		});
	} catch {
		try {
			const entries = await workspace.list(root);
			for (const entry of entries) {
				if (entry.isFile && /\.md$/i.test(entry.name)) paths.push(entry.path);
			}
		} catch {
			return [];
		}
	}
	return paths.sort();
}

function fileStem(path: string): string {
	const name = path.split("/").pop() ?? "agent";
	return name.replace(/\.md$/i, "").toLowerCase();
}

function joinUri(root: string, path: string): string {
	try {
		return acode.joinUrl(root, path);
	} catch {
		return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
	}
}
