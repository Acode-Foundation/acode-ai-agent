import { truncateChars } from "./truncation";
import type { SubagentCatalogEntry, SubagentRunView } from "./types";

export function formatCatalog(entries: SubagentCatalogEntry[]): string {
	if (!entries.length) return "No subagents are available.";
	const rows = entries.map((agent) => {
		const tools = agent.tools[0] === "inherit" ? "inherit parent tools except nested subagents" : agent.tools.join(", ");
		const aliases = agent.aliases.length ? ` aliases: ${agent.aliases.join(", ")}` : "";
		return `- ${agent.name} (${agent.role}, ${agent.scope}${aliases})\n  ${agent.description}\n  tools: ${tools}`;
	});
	return ["Available subagents:", ...rows].join("\n");
}

export function formatRunList(runs: SubagentRunView[]): string {
	if (!runs.length) return "No subagent runs in this session.";
	return runs.map((run) => formatRunLine(run)).join("\n");
}

export function formatRunLine(run: SubagentRunView): string {
	const elapsed = formatElapsed(run.startedAt, run.endedAt);
	const tool = run.lastTool ? ` · ${run.lastTool}` : "";
	const task = truncateChars(run.task.replace(/\s+/g, " ").trim(), 72);
	return `${run.id}  ${run.agent}  ${run.status}  ${elapsed}${tool}\n  ${task}`;
}

export function runFooter(run: Pick<SubagentRunView, "id" | "agent" | "status" | "startedAt" | "endedAt" | "toolCount" | "resumable" | "truncated">): string {
	const elapsed = formatElapsed(run.startedAt, run.endedAt);
	return [
		"<subagent-meta>",
		`id: ${run.id}`,
		`agent: ${run.agent}`,
		`status: ${run.status}`,
		`duration: ${elapsed}`,
		`tools: ${run.toolCount}`,
		`resumable: ${run.resumable ? "yes" : "no"}`,
		run.truncated ? "output: truncated" : undefined,
		"</subagent-meta>",
	].filter(Boolean).join("\n");
}

export function formatDoctor(info: {
	agents: string[];
	maxConcurrent: number;
	timeoutMs: number;
	defaultAsync: boolean;
	bash: boolean;
	permissionMode: string;
	active: number;
	queued: number;
}): string {
	return [
		"Subagent doctor",
		`Agents: ${info.agents.join(", ") || "none"}`,
		`Concurrency: ${info.active} running, ${info.queued} queued, cap ${info.maxConcurrent}`,
		`Timeout: ${Math.round(info.timeoutMs / 1000)}s`,
		`Default launch: ${info.defaultAsync ? "background receipt" : "parent waits"}`,
		`Terminal bash: ${info.bash ? "available" : "unavailable"}`,
		`Permission mode: ${info.permissionMode}`,
		"Children never receive the subagent tool. Results returned to the parent are truncated; inspect a run id for the rest.",
	].join("\n");
}

export function parseSubagentRunId(text?: string): string | undefined {
	if (!text) return undefined;
	return /\b(sa_[a-z0-9]{6,})\b/i.exec(text)?.[1];
}

export function formatElapsed(startedAt: number, endedAt?: number, now = Date.now()): string {
	const ms = Math.max(0, (endedAt ?? now) - startedAt);
	const seconds = Math.round(ms / 1000);
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
