import type { PromptTemplate, Skill } from "@earendil-works/pi-agent-core";

export type SlashCommandSource = "action" | "prompt" | "skill";

export type SlashCommand = {
	name: string;
	description: string;
	source: SlashCommandSource;
	argumentHint?: string;
};

export type ParsedSlashCommand = {
	name: string;
	args: string;
};

export const BUILT_IN_SLASH_COMMANDS: SlashCommand[] = [
	{ name: "model", description: "Choose the model for this session", source: "action" },
	{ name: "scoped-models", description: "Choose models available to this agent", source: "action" },
	{ name: "settings", description: "Open agent settings", source: "action" },
	{ name: "resume", description: "Open an earlier session", source: "action" },
	{ name: "new", description: "Start a fresh session", source: "action" },
	{ name: "compact", description: "Summarize older context to make room", source: "action", argumentHint: "instructions" },
	{ name: "name", description: "Rename this session", source: "action", argumentHint: "name" },
	{ name: "session", description: "Show session usage and identity", source: "action" },
	{ name: "tree", description: "Navigate to an earlier point in this session", source: "action" },
	{ name: "fork", description: "Fork a new session from an earlier message", source: "action" },
	{ name: "clone", description: "Clone the active branch into a new session", source: "action" },
	{ name: "copy", description: "Copy the latest assistant response", source: "action" },
	{ name: "export", description: "Export this session", source: "action", argumentHint: "format" },
	{ name: "import", description: "Import a Pi JSONL session", source: "action" },
	{ name: "reload", description: "Reload project skills and prompts", source: "action" },
	{ name: "hotkeys", description: "Show composer keyboard shortcuts", source: "action" },
	{ name: "login", description: "Manage provider credentials", source: "action" },
	{ name: "logout", description: "Manage provider credentials", source: "action" },
];

export function resourceSlashCommands(resources: { skills?: Skill[]; promptTemplates?: PromptTemplate[] }, options: { enableSkillCommands?: boolean } = {}): SlashCommand[] {
	const prompts = (resources.promptTemplates ?? []).map((template): SlashCommand => ({
		name: template.name,
		description: template.description || "Run this project prompt",
		source: "prompt",
		argumentHint: "arguments",
	}));
	const skills = options.enableSkillCommands === false ? [] : (resources.skills ?? []).map((skill): SlashCommand => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		argumentHint: "instructions",
	}));
	return dedupeCommands([...BUILT_IN_SLASH_COMMANDS, ...prompts, ...skills]);
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
	const match = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?\s*$/.exec(text);
	if (!match?.[1]) return null;
	return { name: match[1].toLowerCase(), args: match[2]?.trim() ?? "" };
}

/** Returns the unfinished command token while the composer should show completion. */
export function slashCommandQuery(text: string): string | null {
	const match = /^\/([^\s/]*)$/.exec(text);
	return match ? match[1]!.toLowerCase() : null;
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return commands;
	return commands
		.map((command, index) => ({ command, index, score: commandScore(command, needle) }))
		.filter((item) => item.score < 100)
		.sort((left, right) => left.score - right.score || left.index - right.index)
		.map((item) => item.command);
}

function commandScore(command: SlashCommand, query: string): number {
	const name = command.name.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (name.includes(query)) return 2;
	if (command.description.toLowerCase().includes(query)) return 3;
	return 100;
}

function dedupeCommands(commands: SlashCommand[]): SlashCommand[] {
	const seen = new Set<string>();
	return commands.filter((command) => {
		const key = command.name.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
