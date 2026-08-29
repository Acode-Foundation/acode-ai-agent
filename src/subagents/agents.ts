import { inferRole, toDefinition } from "./frontmatter";
import type { SubagentCatalogEntry, SubagentDefinition } from "./types";

const SCOUT_PROMPT = `You are scout: a read-only recon subagent.

Map only what another agent needs to act. Do not guess. Start from the paths, symbols, and filenames in the task.

Return:
# Code Context
## Files — exact workspace-relative paths and line ranges, why each matters
## Key code — the types, functions, and short snippets that matter
## Architecture — how the pieces connect
## Start here — the first file to open next
## Risks — constraints, unknowns, and likely change sites

Cite paths and line ranges. Prefer targeted search over whole-file reads.`;

const RESEARCHER_PROMPT = `You are researcher: a web-research subagent.

Answer the question with current sources. Search at least two distinct angles. Fetch full pages only for the best sources. Prefer official docs, specs, and primary evidence.

Return:
# Research: <topic>
## Summary — 2-3 sentences that answer directly
## Findings — numbered claims with inline source URLs
## Sources — kept URLs and why; dropped URLs and why
## Gaps — what is still uncertain

Never invent URLs.`;

const WORKER_PROMPT = `You are worker: the implementation subagent.

You are the writer. Execute the assigned task with the smallest correct change. Follow existing patterns. Do not make unapproved product or architecture decisions.

If a required decision is missing, stop and report it instead of guessing. If the task expects file edits, make them or say that no edits were made.

Return:
Implemented: …
Changed files: …
Validation: …
Open risks: …
Next step: …`;

const REVIEWER_PROMPT = `You are reviewer: a read-only review subagent.

Inspect evidence. Do not guess. Do not edit files.

Check intent match, correctness, edge cases, tests, unintended side effects, and whether the change is minimal.

Return:
## Review
- Correct: what already holds, with evidence
- Finding: P0/P1/P2, issue, location, evidence, smallest fix
- Verdict: BLOCK, OK, or OK with notes

P0 blocks merge. P1 should be fixed before release. P2 is report-only. Say exactly \`No issues found.\` when nothing qualifies. Cite paths and line numbers.`;

const ORACLE_PROMPT = `You are oracle: a decision-consistency subagent. You do not edit files.

Reconstruct inherited decisions and constraints from the briefing and code. Protect them unless evidence supports a pivot.

Return:
Inherited decisions:
Diagnosis:
Drift / contradiction:
Recommendation:
Risks:
Need from parent:
Suggested worker prompt: (only if an implementation handoff is actually warranted; otherwise say none)`;

const DELEGATE_PROMPT = `You are a delegated coding agent. Do the assigned task with the provided tools. Stay inside the task. Prefer small, evidence-backed steps. Report what changed and what remains.`;

export const BUILTIN_AGENTS: SubagentDefinition[] = [
	def("scout", "Fast local codebase recon. Read-only.", ["explorer", "code-scout"], ["read_file", "grep", "glob", "list_dir"], "low", "fresh", SCOUT_PROMPT),
	def("researcher", "Web and docs research with sources.", [], ["web_search", "fetch_content", "read_file"], "medium", "fresh", RESEARCHER_PROMPT),
	def("worker", "Implementation work. Edits files.", ["developer", "coder", "implementer"], "inherit", "high", "brief", WORKER_PROMPT, "writer"),
	def("reviewer", "Code, plan, and diff review. Read-only.", [], ["read_file", "grep", "glob", "list_dir"], "high", "fresh", REVIEWER_PROMPT),
	def("oracle", "Second opinion before acting. Does not edit.", ["advisor"], ["read_file", "grep", "glob", "list_dir"], "high", "brief", ORACLE_PROMPT),
	def("delegate", "General-purpose child close to the parent session.", [], "inherit", undefined, "fresh", DELEGATE_PROMPT, "writer"),
];

export function builtinCatalog(): SubagentDefinition[] {
	return BUILTIN_AGENTS.map(cloneDefinition);
}

export function resolveAgent(name: string, catalog: SubagentDefinition[]): SubagentDefinition {
	const needle = name.trim().toLowerCase();
	if (!needle) throw new Error("An agent name is required.");
	const exact = catalog.find((agent) => agent.name === needle);
	if (exact) return exact;
	const aliases = catalog.filter((agent) => agent.aliases.includes(needle));
	if (aliases.length === 1) return aliases[0]!;
	if (aliases.length > 1) {
		throw new Error(`Agent alias "${needle}" is ambiguous (${aliases.map((agent) => agent.name).join(", ")}). Use a canonical name.`);
	}
	const available = catalog.map((agent) => agent.name).join(", ");
	throw new Error(`Unknown agent "${name}". Available: ${available || "none"}.`);
}

export function catalogEntries(catalog: SubagentDefinition[]): SubagentCatalogEntry[] {
	return catalog.map((agent) => ({
		name: agent.name,
		description: agent.description,
		aliases: [...agent.aliases],
		role: agent.role,
		tools: agent.tools === "inherit" ? ["inherit"] : [...agent.tools],
		scope: agent.scope,
		defaultContext: agent.defaultContext,
	}));
}

export function mergeCatalog(builtins: SubagentDefinition[], overlays: SubagentDefinition[]): SubagentDefinition[] {
	const byName = new Map<string, SubagentDefinition>();
	for (const agent of builtins) byName.set(agent.name, cloneDefinition(agent));
	for (const agent of overlays) byName.set(agent.name, cloneDefinition(agent));
	return [...byName.values()];
}

function def(
	name: string,
	description: string,
	aliases: string[],
	tools: string[] | "inherit",
	thinking: SubagentDefinition["thinking"],
	defaultContext: SubagentDefinition["defaultContext"],
	prompt: string,
	role?: SubagentDefinition["role"],
): SubagentDefinition {
	return {
		name,
		description,
		aliases,
		tools,
		role: role ?? inferRole(name, tools),
		thinking,
		systemPromptMode: name === "delegate" ? "append" : "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		defaultContext,
		prompt,
		scope: "builtin",
		toolBudget: (role ?? inferRole(name, tools)) === "writer" ? 80 : 24,
	};
}

function cloneDefinition(agent: SubagentDefinition): SubagentDefinition {
	return {
		...agent,
		aliases: [...agent.aliases],
		tools: agent.tools === "inherit" ? "inherit" : [...agent.tools],
	};
}

export { toDefinition };
