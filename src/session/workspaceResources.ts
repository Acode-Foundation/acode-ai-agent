import type { AgentHarnessResources, PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { AcodeWorkspace, FileEntry } from "../workspace/acodeWorkspace";

type ResourceEntry = Pick<FileEntry, "path" | "name" | "isFile" | "isDirectory">;
type ResourceReader = {
	list(path: string): Promise<ResourceEntry[]>;
	readText(path: string): Promise<string>;
};

export type LoadedWorkspaceResources = AgentHarnessResources & {
	skillRoots: string[];
};

/** Pi-compatible project and global skill discovery over Acode's virtual filesystems. */
export async function loadWorkspaceResources(workspace: AcodeWorkspace, configuredGlobalRoots: string[] = []): Promise<LoadedWorkspaceResources> {
	const project = workspaceReader(workspace);
	const globalRoots = unique([...configuredGlobalRoots, ...automaticGlobalSkillRoots()]);
	const globalPromptRoots = unique([
		...configuredGlobalRoots.flatMap((root) => siblingPiPromptRoot(root)),
		...automaticGlobalPromptRoots(),
	]);
	const [projectAgents, projectPi, projectPrompts, globalSkillGroups, globalPromptGroups] = await Promise.all([
		loadProjectSkills(workspace, ".agents/skills", false),
		loadProjectSkills(workspace, ".pi/skills", true),
		Promise.all([loadPrompts(project, ".agents/prompts"), loadPrompts(project, ".pi/prompts")]),
		Promise.all(globalRoots.map((root) => loadSkills(uriReader(), root, root.includes("/.pi/")))),
		Promise.all(globalPromptRoots.map((root) => loadPrompts(uriReader(), root))),
	]);
	return {
		// Project resources intentionally win collisions over user-global resources.
		skills: dedupeByName([...projectAgents, ...projectPi, ...globalSkillGroups.flat()]),
		promptTemplates: dedupeByName([...projectPrompts.flat(), ...globalPromptGroups.flat()]),
		skillRoots: globalRoots,
	};
}

async function loadProjectSkills(workspace: AcodeWorkspace, root: string, includeRootMarkdown: boolean): Promise<Skill[]> {
	const paths: string[] = [];
	try {
		await workspace.walk({
			path: root,
			maxFiles: 5_000,
			onEntry(entry) {
				const relative = entry.path.slice(root.length).replace(/^\/+/, "");
				if (entry.name === "SKILL.md" || (includeRootMarkdown && !relative.includes("/") && /\.md$/i.test(entry.name))) paths.push(entry.path);
			},
		});
	} catch {
		// Some remote providers cannot walk hidden roots; the direct reader remains a fallback.
		return loadSkills(workspaceReader(workspace), root, includeRootMarkdown);
	}
	const skills = await Promise.all(paths.sort().map((path) => readSkill(workspaceReader(workspace), path)));
	return skills.filter((skill): skill is Skill => Boolean(skill));
}

export async function pickGlobalSkillsFolder(): Promise<{ uri: string; name: string } | undefined> {
	const browser = acode.require("fileBrowser") as FileBrowser | undefined;
	if (typeof browser !== "function") throw new Error("Acode's folder picker is unavailable.");
	try {
		const picked = await browser("folder", "Choose .agents/skills or .pi/agent/skills", true);
		if (!picked?.url) return undefined;
		const uri = await normalizePickedSkillRoot(picked.url);
		return { uri, name: picked.name || "Skills" };
	} catch (error) {
		if (/cancel|abort/i.test(error instanceof Error ? error.message : String(error))) return undefined;
		throw error;
	}
}

async function normalizePickedSkillRoot(uri: string): Promise<string> {
	if (!/(?:^|\/)(?:\.agents|agent)\/?$/i.test(uri)) return uri;
	try {
		const entries = await acode.fsOperation(uri).lsDir();
		const skills = entries.find((entry) => entry.isDirectory && entry.name === "skills");
		return skills?.url || (skills ? acode.joinUrl(uri, skills.name) : uri);
	} catch {
		return uri;
	}
}

function workspaceReader(workspace: AcodeWorkspace): ResourceReader {
	return { list: (path) => workspace.list(path), readText: (path) => workspace.readText(path) };
}

function uriReader(): ResourceReader {
	return {
		async list(path) {
			const entries = await acode.fsOperation(path).lsDir();
			return entries.map((entry) => ({
				path: entry.url || acode.joinUrl(path, entry.name),
				name: entry.name,
				isFile: entry.isFile,
				isDirectory: entry.isDirectory,
			}));
		},
		readText: (path) => acode.fsOperation(path).readFile("utf-8"),
	};
}

function automaticGlobalSkillRoots(): string[] {
	const roots: string[] = [];
	const storage = (globalThis as { DATA_STORAGE?: string }).DATA_STORAGE;
	if (storage) {
		roots.push(joinUri(storage, ".agents/skills"), joinUri(storage, ".pi/agent/skills"));
	}
	for (const folder of (globalThis as { addedFolder?: Acode.AddedFolder }).addedFolder ?? []) {
		if (/(?:^|\/)\.(?:agents\/skills|pi\/agent\/skills)\/?$/i.test(folder.url)) roots.push(folder.url);
	}
	return unique(roots);
}

function automaticGlobalPromptRoots(): string[] {
	const roots: string[] = [];
	const storage = (globalThis as { DATA_STORAGE?: string }).DATA_STORAGE;
	if (storage) roots.push(joinUri(storage, ".pi/agent/prompts"));
	for (const folder of (globalThis as { addedFolder?: Acode.AddedFolder }).addedFolder ?? []) {
		if (/(?:^|\/)\.pi\/agent\/prompts\/?$/i.test(folder.url)) roots.push(folder.url);
	}
	return unique(roots);
}

function siblingPiPromptRoot(root: string): string[] {
	return /(?:^|\/)\.pi\/agent\/skills\/?$/i.test(root)
		? [root.replace(/skills\/?$/i, "prompts")]
		: [];
}

function joinUri(root: string, path: string): string {
	try {
		return acode.joinUrl(root, path);
	} catch {
		return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
	}
}

async function loadSkills(reader: ResourceReader, root: string, includeRootMarkdown: boolean): Promise<Skill[]> {
	const skills: Skill[] = [];
	await walk(root, true);
	return skills;

	async function walk(dir: string, isRoot: boolean): Promise<void> {
		const entries = await safeList(reader, dir);
		if (!entries) return;
		const skillFile = entries.find((entry) => entry.isFile && entry.name === "SKILL.md");
		if (skillFile) {
			const skill = await readSkill(reader, skillFile.path);
			if (skill) skills.push(skill);
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (entry.isDirectory) await walk(entry.path, false);
			else if (isRoot && includeRootMarkdown && entry.isFile && /\.md$/i.test(entry.name)) {
				const skill = await readSkill(reader, entry.path);
				if (skill) skills.push(skill);
			}
		}
	}
}

async function loadPrompts(reader: ResourceReader, root: string): Promise<PromptTemplate[]> {
	const entries = await safeList(reader, root);
	if (!entries) return [];
	const prompts: PromptTemplate[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile || !/\.md$/i.test(entry.name)) continue;
		try {
			const parsed = parseFrontmatter(await reader.readText(entry.path));
			const firstLine = parsed.body.split("\n").find((line) => line.trim())?.trim() ?? "";
			prompts.push({ name: entry.name.replace(/\.md$/i, ""), description: parsed.values.description || truncate(firstLine, 60), content: parsed.body });
		} catch (error) {
			warn(entry.path, error);
		}
	}
	return prompts;
}

async function readSkill(reader: ResourceReader, path: string): Promise<Skill | null> {
	try {
		const parsed = parseFrontmatter(await reader.readText(path));
		const parts = path.replace(/\/+$/, "").split("/");
		const parentName = parts.at(-2) || parts.at(-1)?.replace(/\.md$/i, "") || "skill";
		const name = parsed.values.name || parentName;
		const description = parsed.values.description?.trim();
		if (!description || !/^[a-z0-9-]+$/.test(name)) {
			console.warn(`AI skill ignored: ${path}: name and description are required.`);
			return null;
		}
		return { name, description, content: parsed.body, filePath: path, disableModelInvocation: parsed.values["disable-model-invocation"] === "true" };
	} catch (error) {
		warn(path, error);
		return null;
	}
}

async function safeList(reader: ResourceReader, path: string): Promise<ResourceEntry[] | null> {
	try {
		return await reader.list(path);
	} catch {
		return null;
	}
}

function parseFrontmatter(content: string): { values: Record<string, string>; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return { values: {}, body: normalized };
	const end = normalized.indexOf("\n---", 4);
	if (end < 0) return { values: {}, body: normalized };
	const values: Record<string, string> = {};
	for (const line of normalized.slice(4, end).split("\n")) {
		const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
		if (match?.[1]) values[match[1]] = unquote(match[2]?.trim() ?? "");
	}
	return { values, body: normalized.slice(end + 4).trim() };
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
	return value;
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function warn(path: string, error: unknown): void {
	console.warn(`AI resource could not be loaded: ${path}`, error);
}

function unique(items: string[]): string[] {
	return [...new Set(items.filter(Boolean))];
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = item.name.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
