import { expect, test } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { CATALOG_OVERLAY, mergeCatalogOverlay } from "../src/providers/catalogOverlay.ts";
import { clampThinkingLevel, thinkingLevelsFor } from "../src/providers/thinkingLevels.ts";

const grok45 = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-responses",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
} as Model<any>;

test("Grok 4.5 only offers low, medium, and high", () => {
	expect(thinkingLevelsFor(grok45).map((level) => level.id)).toEqual(["low", "medium", "high"]);
	expect(clampThinkingLevel(grok45, "xhigh")).toBe("high");
	expect(clampThinkingLevel(grok45, "off")).toBe("high");
});

test("Grok 4.6 overlay adds xhigh and is merged into the frozen catalog", () => {
	const overlay = CATALOG_OVERLAY.xai?.find((model) => model.id === "grok-4.6");
	expect(overlay).toBeTruthy();
	expect(thinkingLevelsFor(overlay!).map((level) => level.id)).toEqual(["low", "medium", "high", "xhigh"]);
	const merged = mergeCatalogOverlay("xai", [grok45]);
	expect(merged.map((model) => model.id).sort()).toEqual(["grok-4.5", "grok-4.6"]);
});

test("models without reasoning only offer off", () => {
	expect(thinkingLevelsFor({ ...grok45, reasoning: false, thinkingLevelMap: undefined }).map((level) => level.id)).toEqual(["off"]);
});
