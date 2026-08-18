import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentFeature } from "./types";

export type ContextContribution = () => string | Promise<string>;

export class ExtensionRegistry {
	#tools = new Map<string, AgentTool>();
	#context = new Map<string, ContextContribution>();
	#features = new Map<string, AgentFeature>();

	registerTool(tool: AgentTool): () => void {
		if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.#tools.set(tool.name, tool);
		return () => this.#tools.delete(tool.name);
	}

	registerContext(id: string, contribution: ContextContribution): () => void {
		if (this.#context.has(id)) throw new Error(`Context source already registered: ${id}`);
		this.#context.set(id, contribution);
		return () => this.#context.delete(id);
	}

	registerFeature(feature: AgentFeature): () => void {
		if (this.#features.has(feature.id)) throw new Error(`Feature already registered: ${feature.id}`);
		this.#features.set(feature.id, feature);
		return () => this.#features.delete(feature.id);
	}

	get tools(): AgentTool[] {
		return [...this.#tools.values()];
	}

	get contextSources(): ContextContribution[] {
		return [...this.#context.values()];
	}

	get features(): AgentFeature[] {
		return [...this.#features.values()];
	}
}

