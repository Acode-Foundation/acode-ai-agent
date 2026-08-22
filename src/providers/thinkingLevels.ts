import {
	clampThinkingLevel as clampModelThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

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
	if (!model) return [];
	const supported = getSupportedThinkingLevels(model);
	if (!supported.some((level) => level !== "off")) return [];
	return THINKING_LEVELS.filter((level) => supported.includes(level.id));
}

export function clampThinkingLevel(model: Model<any> | undefined, level: ModelThinkingLevel): ModelThinkingLevel {
	return model ? clampModelThinkingLevel(model, level) : level;
}
