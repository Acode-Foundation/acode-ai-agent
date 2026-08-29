import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SUBAGENT_ACTIONS = [
	"list",
	"get",
	"status",
	"stop",
	"steer",
	"resume",
	"doctor",
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

export type SubagentContextMode = "fresh" | "brief";

export type SubagentRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "timed_out";

export type SubagentRole = "read-only" | "writer";

export type SubagentScope = "builtin" | "project" | "user";

export type SubagentDefinition = {
	name: string;
	description: string;
	aliases: string[];
	tools: string[] | "inherit";
	role: SubagentRole;
	thinking?: ThinkingLevel;
	systemPromptMode: "replace" | "append";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext: SubagentContextMode;
	prompt: string;
	scope: SubagentScope;
	sourcePath?: string;
	toolBudget: number;
};

export type SubagentLaunchSpec = {
	agent: string;
	task: string;
	async?: boolean;
	context?: SubagentContextMode;
	timeoutMs?: number;
};

export type SubagentWorkItem = {
	id: string;
	name: string;
	label: string;
	detail?: string;
	status: "running" | "done" | "error";
	summary?: string;
};

export type SubagentRunView = {
	id: string;
	agent: string;
	task: string;
	status: SubagentRunStatus;
	async: boolean;
	startedAt: number;
	endedAt?: number;
	lastTool?: string;
	toolCount: number;
	output?: string;
	error?: string;
	truncated?: boolean;
	resumable: boolean;
	resumedFrom?: string;
	modelId?: string;
};

export type SubagentInspect = {
	run: SubagentRunView;
	work: SubagentWorkItem[];
	output: string;
};

export type SubagentCatalogEntry = {
	name: string;
	description: string;
	aliases: string[];
	role: SubagentRole;
	tools: string[];
	scope: SubagentScope;
	defaultContext: SubagentContextMode;
};

export const READ_TOOL_NAMES = ["read_file", "list_dir", "grep", "glob"] as const;
export const WRITE_TOOL_NAMES = ["write_file", "edit_file"] as const;
export const WEB_TOOL_NAMES = ["web_search", "fetch_content"] as const;
export const MUTATION_TOOL_NAMES = ["write_file", "edit_file", "bash"] as const;

export const TOOL_ALIASES: Record<string, string> = {
	read: "read_file",
	read_file: "read_file",
	ls: "list_dir",
	list: "list_dir",
	list_dir: "list_dir",
	grep: "grep",
	find: "glob",
	glob: "glob",
	write: "write_file",
	write_file: "write_file",
	edit: "edit_file",
	edit_file: "edit_file",
	bash: "bash",
	web_search: "web_search",
	fetch_content: "fetch_content",
	load_skill: "load_skill",
};

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 480_000;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 2;
export const MAX_SUBAGENT_SPAWNS_PER_RUN = 8;
export const MAX_RETAINED_SUBAGENT_RUNS = 12;
export const MAX_PARALLEL_LAUNCH = 4;
export const MAX_CHAIN_STEPS = 6;
export const PARENT_RESULT_MAX_BYTES = 8_000;
export const PARENT_RESULT_MAX_LINES = 180;
export const INSPECT_OUTPUT_MAX_CHARS = 32_000;
export const BRIEFING_MAX_CHARS = 8_000;
export const TASK_MAX_CHARS = 24_000;
