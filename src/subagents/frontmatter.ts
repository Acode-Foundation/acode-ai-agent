import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentContextMode, SubagentDefinition, SubagentRole, SubagentScope } from "./types";
import { TOOL_ALIASES } from "./types";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_NAME = /^[a-z][a-z0-9-]{0,40}$/;

export type ParsedAgentFile = {
	name: string;
	description: string;
	aliases: string[];
	tools: string[] | "inherit";
	thinking?: ThinkingLevel;
	systemPromptMode: "replace" | "append";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext: SubagentContextMode;
	acceptanceRole?: SubagentRole;
	prompt: string;
};

export function parseAgentMarkdown(content: string, fallbackName: string): ParsedAgentFile {
	const { values, body } = parseFrontmatter(content);
	const name = String(first(values.name) ?? fallbackName).trim().toLowerCase();
	if (!AGENT_NAME.test(name)) throw new Error(`Invalid agent name "${name}". Use lowercase letters, digits, and hyphens.`);
	const description = String(first(values.description) ?? "").trim();
	if (!description) throw new Error(`Agent ${name} is missing a description.`);
	const tools = parseTools(values.tools);
	const thinkingRaw = first(values.thinking)?.trim().toLowerCase();
	const thinking = thinkingRaw && THINKING_LEVELS.has(thinkingRaw) ? thinkingRaw as ThinkingLevel : undefined;
	const roleRaw = first(values.acceptanceRole)?.trim().toLowerCase();
	return {
		name,
		description,
		aliases: splitList(values.aliases).map((item) => item.toLowerCase()).filter((item) => item !== name),
		tools,
		thinking,
		systemPromptMode: first(values.systemPromptMode)?.trim().toLowerCase() === "append" ? "append" : "replace",
		inheritProjectContext: parseBoolean(first(values.inheritProjectContext), true),
		inheritSkills: parseBoolean(first(values.inheritSkills), false),
		defaultContext: first(values.defaultContext)?.trim().toLowerCase() === "brief" || first(values.defaultContext)?.trim().toLowerCase() === "fork"
			? "brief"
			: "fresh",
		acceptanceRole: roleRaw === "writer" ? "writer" : roleRaw === "read-only" ? "read-only" : undefined,
		prompt: body.trim(),
	};
}

export function toDefinition(parsed: ParsedAgentFile, scope: SubagentScope, sourcePath?: string): SubagentDefinition {
	const tools = parsed.tools === "inherit" ? "inherit" : canonicalTools(parsed.tools);
	const role = parsed.acceptanceRole ?? inferRole(parsed.name, tools);
	return {
		name: parsed.name,
		description: parsed.description,
		aliases: parsed.aliases,
		tools,
		role,
		thinking: parsed.thinking,
		systemPromptMode: parsed.systemPromptMode,
		inheritProjectContext: parsed.inheritProjectContext,
		inheritSkills: parsed.inheritSkills,
		defaultContext: parsed.defaultContext,
		prompt: parsed.prompt,
		scope,
		sourcePath,
		toolBudget: role === "writer" ? 80 : 24,
	};
}

export function canonicalTools(names: string[]): string[] {
	const seen = new Set<string>();
	const tools: string[] = [];
	for (const raw of names) {
		const mapped = TOOL_ALIASES[raw.trim().toLowerCase()];
		if (!mapped || seen.has(mapped)) continue;
		seen.add(mapped);
		tools.push(mapped);
	}
	return tools;
}

export function inferRole(name: string, tools: string[] | "inherit"): SubagentRole {
	if (name === "worker" || name === "delegate") return "writer";
	if (tools === "inherit") return "writer";
	return tools.some((tool) => tool === "write_file" || tool === "edit_file" || tool === "bash") ? "writer" : "read-only";
}

export function isAgentName(value: string): boolean {
	return AGENT_NAME.test(value);
}

type FrontmatterValues = Record<string, string | string[]>;

export function parseFrontmatter(content: string): { values: FrontmatterValues; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return { values: {}, body: normalized };
	const end = normalized.indexOf("\n---", 4);
	if (end < 0) return { values: {}, body: normalized };
	const values: FrontmatterValues = {};
	const lines = normalized.slice(4, end).split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const match = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const key = match[1];
		const raw = match[2]?.trim() ?? "";
		if (!raw) {
			const items: string[] = [];
			while (index + 1 < lines.length && /^\s+-\s+\S/.test(lines[index + 1]!)) {
				index += 1;
				items.push(lines[index]!.replace(/^\s+-\s+/, "").trim());
			}
			values[key] = items.length ? items : "";
			continue;
		}
		values[key] = unquote(raw);
	}
	return { values, body: normalized.slice(end + 4).trim() };
}

function parseTools(value: string | string[] | undefined): string[] | "inherit" {
	if (value === undefined) return "inherit";
	const items = splitList(value);
	if (items.length === 1 && items[0] === "inherit") return "inherit";
	if (items.length === 0) return [];
	return items;
}

function splitList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const items = Array.isArray(value) ? value : value.split(/[,]+/);
	return items.map((item) => item.trim()).filter(Boolean);
}

function first(value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value[0] : value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
	if (normalized === "false" || normalized === "no" || normalized === "0") return false;
	return fallback;
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}
