import { expect, test } from "vitest";
import { builtinCatalog, mergeCatalog, resolveAgent } from "../src/subagents/agents.ts";
import { buildBriefing } from "../src/subagents/briefing.ts";
import { applyToolBudget, toolsForAgent } from "../src/subagents/filterTools.ts";
import { formatCatalog, parseSubagentRunId, runFooter } from "../src/subagents/format.ts";
import { canonicalTools, parseAgentMarkdown, parseFrontmatter, toDefinition } from "../src/subagents/frontmatter.ts";
import { parentDelegationPrompt } from "../src/subagents/prompt.ts";
import { createSubagentTool } from "../src/subagents/tool.ts";
import { truncateForParent } from "../src/subagents/truncation.ts";
import type { SubagentRuntime } from "../src/subagents/runtime.ts";
import { presentTool } from "../src/ui/transcript.ts";
import { parseSlashCommand, resourceSlashCommands } from "../src/core/slashCommands.ts";
import { parseSettings } from "../src/core/schema.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";

test("builtin catalog resolves names and aliases", () => {
	const catalog = builtinCatalog();
	expect(resolveAgent("scout", catalog).name).toBe("scout");
	expect(resolveAgent("advisor", catalog).name).toBe("oracle");
	expect(resolveAgent("implementer", catalog).name).toBe("worker");
	expect(resolveAgent("reviewer", catalog).role).toBe("read-only");
	expect(resolveAgent("worker", catalog).role).toBe("writer");
	expect(() => resolveAgent("not-an-agent", catalog)).toThrow(/Unknown agent/);
});

test("project agents override builtins with the same name", () => {
	const overlay = toDefinition(parseAgentMarkdown(`---
name: scout
description: Project scout
tools: read, grep
---
Stay inside auth.`, "scout"), "project", ".pi/agents/scout.md");
	const merged = mergeCatalog(builtinCatalog(), [overlay]);
	const scout = resolveAgent("scout", merged);
	expect(scout.scope).toBe("project");
	expect(scout.description).toBe("Project scout");
	expect(scout.tools).toEqual(["read_file", "grep"]);
	expect(scout.sourcePath).toBe(".pi/agents/scout.md");
});

test("frontmatter parses comma lists and block lists", () => {
	const parsed = parseFrontmatter(`---
name: reviewer
description: Review diffs
aliases:
  - audit
  - critic
tools: read, grep, find
inheritProjectContext: false
---
Body here.`);
	expect(parsed.values.name).toBe("reviewer");
	expect(parsed.values.aliases).toEqual(["audit", "critic"]);
	expect(parsed.values.tools).toBe("read, grep, find");
	expect(parsed.body).toBe("Body here.");
	expect(canonicalTools(["read", "find", "ls", "read_file"])).toEqual(["read_file", "glob", "list_dir"]);
});

test("truncation keeps the metadata footer after a large body", () => {
	const body = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
	const footer = runFooter({
		id: "sa_abcd1234",
		agent: "scout",
		status: "completed",
		startedAt: 1,
		endedAt: 4_000,
		toolCount: 3,
		resumable: true,
		truncated: true,
	});
	const truncated = truncateForParent(body, footer, { maxBytes: 800, maxLines: 12 });
	expect(truncated.truncated).toBe(true);
	expect(truncated.text).toContain("id: sa_abcd1234");
	expect(truncated.text).toContain("</subagent-meta>");
	expect(truncated.text.endsWith("</subagent-meta>")).toBe(true);
	expect(truncated.text).toContain("truncated");
	expect(truncated.text.indexOf("<subagent-meta>")).toBeGreaterThan(truncated.text.indexOf("omitted"));
});

test("parent briefing is compact and ignores older turns", () => {
	const briefing = buildBriefing([
		{ role: "user", content: "old request", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "old answer" }], api: "openai-completions", provider: "test", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
		{ role: "user", content: "review the auth change", timestamp: 3 },
		{ role: "assistant", content: [{ type: "text", text: "I will inspect src/auth.ts" }], api: "openai-completions", provider: "test", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 },
	], 8_000);
	expect(briefing).toContain("review the auth change");
	expect(briefing).toContain("src/auth.ts");
	expect(briefing).not.toContain("old request");
});

test("read-only agents cannot receive mutation tools even if listed", () => {
	const available = [
		fakeTool("read_file"),
		fakeTool("grep"),
		fakeTool("write_file"),
		fakeTool("bash"),
		fakeTool("subagent"),
	];
	const scout = resolveAgent("scout", builtinCatalog());
	const tools = toolsForAgent({ ...scout, tools: ["read_file", "grep", "write_file", "bash"] }, available);
	expect(tools.map((tool) => tool.name)).toEqual(["read_file", "grep"]);
});

test("tool budget blocks further calls after the hard limit", async () => {
	let calls = 0;
	const [tool] = applyToolBudget([fakeTool("grep", async () => {
		calls += 1;
		return { content: [{ type: "text", text: "ok" }] };
	})], 2);
	await tool!.execute("1", {}, undefined, undefined);
	await tool!.execute("2", {}, undefined, undefined);
	await expect(tool!.execute("3", {}, undefined, undefined)).rejects.toThrow(/budget exhausted/);
	expect(calls).toBe(2);
});

test("parent delegation prompt lists agents without dumping their system prompts", () => {
	const prompt = parentDelegationPrompt(builtinCatalog().map((agent) => ({
		name: agent.name,
		description: agent.description,
		aliases: agent.aliases,
		role: agent.role,
		tools: agent.tools === "inherit" ? ["inherit"] : agent.tools,
		scope: agent.scope,
		defaultContext: agent.defaultContext,
	})));
	expect(prompt.length).toBeLessThan(1_600);
	expect(prompt).toContain("scout:");
	expect(prompt).not.toContain("You are scout:");
	expect(formatCatalog(builtinCatalog().map((agent) => ({
		name: agent.name,
		description: agent.description,
		aliases: agent.aliases,
		role: agent.role,
		tools: agent.tools === "inherit" ? ["inherit"] : agent.tools,
		scope: agent.scope,
		defaultContext: agent.defaultContext,
	}))).startsWith("Available subagents")).toBe(true);
});

test("subagent tool routes management actions without launching", async () => {
	const runtime = {
		listAgents: () => "Available subagents:\n- scout",
		getAgent: (name: string) => `got ${name}`,
		status: (id?: string) => id ? `status ${id}` : "no runs",
		doctor: () => "Subagent doctor",
	} as unknown as SubagentRuntime;
	const tool = createSubagentTool(runtime);
	const listed = await tool.execute("t1", { action: "list" });
	expect(listed.content[0]).toEqual({ type: "text", text: "Available subagents:\n- scout" });
	const got = await tool.execute("t2", { action: "get", agent: "reviewer" });
	expect(got.content[0]).toMatchObject({ type: "text", text: "got reviewer" });
	await expect(tool.execute("t3", { action: "explode" })).rejects.toThrow(/Unknown action/);
	await expect(tool.execute("t4", {})).rejects.toThrow(/Pass agent\+task/);
});

test("subagent work rows and run ids parse from truncated results", () => {
	const presented = presentTool("subagent", { agent: "scout", task: "Map auth" });
	expect(presented).toMatchObject({ kind: "delegate", label: "Subagent", detail: "scout" });
	expect(parseSubagentRunId("Started scout (sa_abc123def0) in the background.")).toBe("sa_abc123def0");
	expect(parseSubagentRunId("id: sa_deadbeef01")).toBe("sa_deadbeef01");
});

test("slash commands include subagent inspection", () => {
	const commands = resourceSlashCommands({});
	expect(commands.some((command) => command.name === "subagents")).toBe(true);
	expect(commands.some((command) => command.name === "subagents-list")).toBe(true);
	expect(parseSlashCommand("/subagents")).toEqual({ name: "subagents", args: "" });
});

test("settings default to two concurrent foreground subagents", () => {
	const settings = parseSettings({});
	expect(settings.subagentMaxConcurrent).toBe(2);
	expect(settings.subagentTimeoutMs).toBe(480_000);
	expect(settings.subagentDefaultAsync).toBe(false);
});

function fakeTool(name: string, execute?: AgentTool["execute"]): AgentTool<any> {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: execute ?? (async () => ({ content: [{ type: "text", text: name }] })),
	};
}
