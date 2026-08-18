import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

const THINKING_LEVELS: Array<{ id: ModelThinkingLevel; label: string }> = [
	{ id: "off", label: "Off" },
	{ id: "minimal", label: "Min" },
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Med" },
	{ id: "high", label: "High" },
	{ id: "xhigh", label: "XHigh" },
	{ id: "max", label: "Max" },
];

export function thinkingLevelsFor(model?: Model<any>): typeof THINKING_LEVELS {
	if (!model) return THINKING_LEVELS;
	if (!model.reasoning) return THINKING_LEVELS.filter((level) => level.id === "off");
	const map = model.thinkingLevelMap;
	if (map) return THINKING_LEVELS.filter((level) => map[level.id] !== null);
	const compat = model.compat as { supportsReasoningEffort?: boolean } | undefined;
	if (compat?.supportsReasoningEffort === false) return THINKING_LEVELS.filter((level) => level.id === "off");
	return THINKING_LEVELS;
}

export function clampThinkingLevel(model: Model<any> | undefined, level: ModelThinkingLevel): ModelThinkingLevel {
	const levels = thinkingLevelsFor(model);
	if (levels.some((item) => item.id === level)) return level;
	return levels.find((item) => item.id === "high")?.id
		?? levels.find((item) => item.id === "medium")?.id
		?? levels[0]?.id
		?? "off";
}
