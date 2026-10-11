import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolExposure } from "../tools/toolSearch";
import type { AgentFeature } from "./types";

export type ContextContribution = () => string | Promise<string>;

export class ExtensionRegistry {
  #tools = new Map<string, ToolRegistration>();
  #deferred = new Set<string>();
  #context = new Map<string, ContextContribution>();
  #features = new Map<string, AgentFeature>();

  /** `deferred` tools stay out of requests until the model loads them with `tool_search`. */
  registerTool(tool: ToolRegistration, options: { exposure?: ToolExposure } = {}): () => void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool);
    if (options.exposure === "deferred") this.#deferred.add(tool.name);
    return () => {
      this.#tools.delete(tool.name);
      this.#deferred.delete(tool.name);
    };
  }

  registerContext(id: string, contribution: ContextContribution): () => void {
    if (this.#context.has(id)) throw new Error(`Context source already registered: ${id}`);
    this.#context.set(id, contribution);
    return () => this.#context.delete(id);
  }

  registerFeature(feature: AgentFeature): () => void {
    if (this.#features.has(feature.id))
      throw new Error(`Feature already registered: ${feature.id}`);
    this.#features.set(feature.id, feature);
    return () => this.#features.delete(feature.id);
  }

  get tools(): ToolRegistration[] {
    return [...this.#tools.values()];
  }

  /** Names of plugin tools registered as deferred. */
  get deferredTools(): ReadonlySet<string> {
    return this.#deferred;
  }

  get contextSources(): ContextContribution[] {
    return [...this.#context.values()];
  }

  get features(): AgentFeature[] {
    return [...this.#features.values()];
  }
}
