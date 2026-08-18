import { parseSettings } from "./schema";
import type { AgentSettings } from "./types";

const STORAGE_KEY = "acode.ai-agent.settings.v1";

export const DEFAULT_SETTINGS: AgentSettings = {
	providerId: "openrouter",
	modelId: "qwen/qwen3.7-flash",
	thinkingLevel: "medium",
	permissionMode: "ask",
	includeSelection: true,
	maxHistoryMessages: 80,
	maxWalkFiles: 200,
	activeWorkspaceId: "",
	activeChatId: "",
	customModels: {},
};

export class SettingsStore {
	#value: AgentSettings;
	#listeners = new Set<(settings: AgentSettings) => void>();

	constructor() {
		this.#value = this.#read();
	}

	get value(): AgentSettings {
		return { ...this.#value, customModels: { ...this.#value.customModels } };
	}

	update(patch: Partial<AgentSettings>): AgentSettings {
		const next = this.#sanitize({ ...this.#value, ...patch });
		this.#value = next;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch (error) {
			console.warn("AI settings could not be persisted", error);
		}
		for (const listener of this.#listeners) listener(this.value);
		return this.value;
	}

	subscribe(listener: (settings: AgentSettings) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#read(): AgentSettings {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return { ...DEFAULT_SETTINGS };
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (parsed.autoApproveEdits === true && parsed.permissionMode === undefined) parsed.permissionMode = "allow-edits";
			return this.#sanitize({ ...DEFAULT_SETTINGS, ...parsed });
		} catch {
			return { ...DEFAULT_SETTINGS };
		}
	}

	#sanitize(value: AgentSettings): AgentSettings {
		return { ...DEFAULT_SETTINGS, ...parseSettings(value) };
	}
}
