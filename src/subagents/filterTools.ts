import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MUTATION_TOOL_NAMES } from "./types";
import type { SubagentDefinition } from "./types";

const SUBAGENT_TOOL = "subagent";

export function parentToolsWithoutSubagent(tools: AgentTool[]): AgentTool[] {
	return tools.filter((tool) => tool.name !== SUBAGENT_TOOL);
}

export function toolsForAgent(agent: SubagentDefinition, available: AgentTool[]): AgentTool[] {
	const pool = parentToolsWithoutSubagent(available);
	if (agent.tools === "inherit") return pool;
	const allow = new Set(agent.tools);
	const selected = pool.filter((tool) => allow.has(tool.name));
	if (agent.role === "read-only") {
		return selected.filter((tool) => !isMutationTool(tool.name));
	}
	return selected;
}

export function applyToolBudget(
	tools: AgentTool[],
	budget: number,
	onCall?: (count: number, name: string) => void,
): AgentTool[] {
	if (budget <= 0) return tools;
	let count = 0;
	return tools.map((tool) => ({
		...tool,
		execute: async (id, params, signal, onUpdate) => {
			count += 1;
			onCall?.(count, tool.name);
			if (count > budget) {
				throw new Error(`Tool budget exhausted after ${budget} calls. Finish with the evidence you have.`);
			}
			return tool.execute(id, params, signal, onUpdate);
		},
	}));
}

export function isMutationTool(name: string): boolean {
	return (MUTATION_TOOL_NAMES as readonly string[]).includes(name);
}
