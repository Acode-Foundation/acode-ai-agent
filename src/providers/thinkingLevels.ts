import {
	clampThinkingLevel as clampModelThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
	off: "Off",
	minimal: "Min",
	low: "Low",
	medium: "Med",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

export function thinkingLevelsFor(model?: Model<any>): Array<{ id: ModelThinkingLevel; label: string }> {
	if (!model) return [];
	const supported = getSupportedThinkingLevels(model);
	if (!supported.some((level) => level !== "off")) return [];
	return supported.map((id) => ({ id, label: THINKING_LABELS[id] }));
}

export function clampThinkingLevel(model: Model<any> | undefined, level: ModelThinkingLevel): ModelThinkingLevel {
	return model ? clampModelThinkingLevel(model, level) : level;
}
