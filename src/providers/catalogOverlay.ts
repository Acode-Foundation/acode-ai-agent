import type { Model } from "@earendil-works/pi-ai";

/** Models newer than the frozen 0.83.0 catalog. Overlay wins on id collision. */
export const CATALOG_OVERLAY: Record<string, Model<any>[]> = {
	xai: [
		{
			id: "grok-4.6",
			name: "Grok 4.6",
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 500_000,
			maxTokens: 500_000,
			compat: { supportsLongCacheRetention: false },
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		},
	],
	openrouter: [
		{
			id: "x-ai/grok-4.6",
			name: "xAI: Grok 4.6",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 500_000,
			maxTokens: 500_000,
			compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		},
	],
};

export function mergeCatalogOverlay(providerId: string, catalog: Model<any>[]): Model<any>[] {
	const extras = CATALOG_OVERLAY[providerId] ?? [];
	if (!extras.length) return catalog;
	const byId = new Map(catalog.map((model) => [model.id, model]));
	for (const extra of extras) {
		if (!byId.has(extra.id)) byId.set(extra.id, extra);
	}
	return [...byId.values()];
}
