import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { catalogEntries } from "./agents";
import type { SubagentCatalogEntry, SubagentDefinition } from "./types";

const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", ".agents.md"];

export function parentDelegationPrompt(entries: SubagentCatalogEntry[]): string {
	if (!entries.length) return "";
	const list = entries.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	return [
		"Delegation: use the subagent tool for isolated scout, research, review, oracle, or worker work.",
		"Each child has its own session. The parent only receives a truncated result plus a run id.",
		"Do not paste child transcripts into the chat. Do not spawn children for trivial single-file reads you can do yourself.",
		"Default to one child. At most two may run at once. Children cannot spawn children.",
		"Foreground launches block until the child finishes. Use async:true only when the parent can continue without the result.",
		"Check status by id instead of polling in a loop.",
		"Available subagents:",
		list,
	].join("\n");
}

export async function buildChildSystemPrompt(options: {
	agent: SubagentDefinition;
	workspace: AcodeWorkspace;
	parentPrompt?: string;
	briefing?: string;
}): Promise<string> {
	const parts: string[] = [
		`You are ${options.agent.name}, a focused subagent inside Acode. You are not the parent agent.`,
		"File-tool paths are POSIX and workspace-relative. Never pass device paths, absolute paths, or URIs.",
		`Workspace: ${options.workspace.info.name}.`,
		"Do not spawn subagents. Do not ask the user questions unless you are blocked.",
		"Keep the final response complete and concise. The parent only sees a truncated copy.",
	];
	if (options.agent.role === "read-only") {
		parts.push("You cannot edit files or run mutating commands. Report what a writer should change.");
	}
	if (options.agent.systemPromptMode === "append" && options.parentPrompt) {
		parts.push(options.parentPrompt);
	}
	if (options.agent.inheritProjectContext) {
		const instructions = await readProjectInstructions(options.workspace);
		if (instructions) parts.push(instructions);
	}
	if (options.agent.prompt) parts.push(options.agent.prompt);
	if (options.briefing) parts.push(`Parent briefing:\n${options.briefing}`);
	return parts.join("\n\n");
}

export async function readProjectInstructions(workspace: AcodeWorkspace): Promise<string | undefined> {
	for (const file of PROJECT_INSTRUCTION_FILES) {
		try {
			const text = await workspace.readText(file);
			const clipped = text.slice(0, 16_000);
			return `Project instructions from ${file}:\n${clipped}`;
		} catch {
			// Optional.
		}
	}
	return undefined;
}

export function catalogPromptEntries(catalog: SubagentDefinition[]): SubagentCatalogEntry[] {
	return catalogEntries(catalog);
}
