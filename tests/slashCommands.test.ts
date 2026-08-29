import { expect, test } from "vitest";
import {
	filterSlashCommands,
	parseSlashCommand,
	resourceSlashCommands,
	slashCommandQuery,
} from "../src/core/slashCommands.ts";
import { loadWorkspaceResources } from "../src/session/workspaceResources.ts";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace.ts";

test("parses a slash command and preserves its argument text", () => {
	expect(parseSlashCommand(" /compact focus on the API changes ")).toEqual({
		name: "compact",
		args: "focus on the API changes",
	});
	expect(parseSlashCommand("ordinary prompt")).toBeNull();
	expect(parseSlashCommand("//not-a-command")).toBeNull();
});

test("only opens completion while the first slash token is being typed", () => {
	expect(slashCommandQuery("/")).toBe("");
	expect(slashCommandQuery("/ski")).toBe("ski");
	expect(slashCommandQuery("/skill:review more context")).toBeNull();
	expect(slashCommandQuery("Please /review")).toBeNull();
});

test("merges built-ins, prompt templates, and Pi skill commands", () => {
	const commands = resourceSlashCommands({
		promptTemplates: [{ name: "review", description: "Review this change", content: "Review $ARGUMENTS" }],
		skills: [{ name: "frontend", description: "Build the interface", content: "instructions", filePath: ".agents/skills/frontend/SKILL.md" }],
	});
	expect(commands.some((command) => command.name === "model" && command.source === "action")).toBe(true);
	expect(commands.some((command) => command.name === "tasks" && command.source === "action")).toBe(true);
	expect(commands.some((command) => command.name === "review" && command.source === "prompt")).toBe(true);
	expect(commands.some((command) => command.name === "skill:frontend" && command.source === "skill")).toBe(true);
});

test("command filtering ranks exact and prefix matches before description matches", () => {
	const commands = resourceSlashCommands({
		promptTemplates: [{ name: "review", description: "Inspect the model setup", content: "Review" }],
	});
	const matches = filterSlashCommands(commands, "model").map((command) => command.name);
	expect(matches[0]).toBe("model");
	expect(matches.indexOf("scoped-models")).toBeLessThan(matches.indexOf("review"));
});

test("loads project skills and prompts from Acode's virtual workspace", async () => {
	const files: Record<string, string> = {
		".agents/skills/reviewer/SKILL.md": "---\nname: reviewer\ndescription: Review code carefully\n---\nCheck correctness first.",
		".pi/skills/release.md": "---\nname: release\ndescription: Prepare a release\n---\nShip carefully.",
		".pi/prompts/explain.md": "---\ndescription: Explain selected code\n---\nExplain $ARGUMENTS",
	};
	const directories: Record<string, Array<{ path: string; name: string; isFile: boolean; isDirectory: boolean }>> = {
		".agents/skills": [{ path: ".agents/skills/reviewer", name: "reviewer", isFile: false, isDirectory: true }],
		".agents/skills/reviewer": [{ path: ".agents/skills/reviewer/SKILL.md", name: "SKILL.md", isFile: true, isDirectory: false }],
		".pi/prompts": [{ path: ".pi/prompts/explain.md", name: "explain.md", isFile: true, isDirectory: false }],
	};
	const workspace = {
		async walk(options: { path?: string; onEntry: (entry: { path: string; name: string; isFile: boolean; isDirectory: boolean }) => void }) {
			for (const [path] of Object.entries(files)) {
				if (options.path && !path.startsWith(`${options.path}/`)) continue;
				options.onEntry({ path, name: path.split("/").at(-1)!, isFile: true, isDirectory: false });
			}
			return { visited: Object.keys(files).length, truncated: false };
		},
		async list(path: string) {
			const entries = directories[path];
			if (!entries) throw new Error("not found");
			return entries;
		},
		async readText(path: string) {
			const content = files[path];
			if (!content) throw new Error("not found");
			return content;
		},
	} as unknown as AcodeWorkspace;
	const resources = await loadWorkspaceResources(workspace);
	expect(resources.skills).toEqual([
		expect.objectContaining({ name: "reviewer", description: "Review code carefully" }),
		expect.objectContaining({ name: "release", description: "Prepare a release" }),
	]);
	expect(resources.promptTemplates).toEqual([expect.objectContaining({ name: "explain", description: "Explain selected code" })]);
});
