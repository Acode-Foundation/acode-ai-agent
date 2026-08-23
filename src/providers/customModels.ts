import type { Model } from "@earendil-works/pi-ai";
import type { ProviderId } from "../core/types";

const MODEL_ID = /^[a-zA-Z0-9][\w./:+-]{0,119}$/;

const PROVIDER_DEFAULTS: Record<string, Pick<Model<any>, "api" | "baseUrl" | "compat">> = {
	openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" } },
	openai: { api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
	"openai-codex": { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
	anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com" },
	xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1" },
	groq: { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
	deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
	mistral: { api: "mistral-conversations", baseUrl: "https://api.mistral.ai" },
	cerebras: { api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
	fireworks: { api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
	together: { api: "openai-completions", baseUrl: "https://api.together.xyz/v1" },
	huggingface: { api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
	moonshotai: { api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
	minimax: { api: "openai-completions", baseUrl: "https://api.minimax.io/v1" },
	zai: { api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
	nvidia: { api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1" },
	"kimi-coding": { api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding" },
	opencode: { api: "openai-completions", baseUrl: "https://opencode.ai/zen/v1" },
	"qwen-token-plan": { api: "openai-completions", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
	"ant-ling": { api: "openai-completions", baseUrl: "https://api.ant-ling.com/v1" },
	xiaomi: { api: "openai-completions", baseUrl: "https://api.xiaomimimo.com/v1" },
};

export function sanitizeModelId(value: string): string | undefined {
	const id = value.trim();
	if (!id || id.length > 120) return undefined;
	if (/:\/\//.test(id) || id.includes("..") || id.startsWith("/") || id.startsWith(".")) return undefined;
	if (!MODEL_ID.test(id) || !/[a-zA-Z]/.test(id)) return undefined;
	return id;
}

export function sanitizeCustomModels(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object") return {};
	const next: Record<string, string[]> = {};
	for (const [providerId, ids] of Object.entries(value as Record<string, unknown>)) {
		if (!providerId || !Array.isArray(ids)) continue;
		const unique = [...new Set(ids.map((id) => sanitizeModelId(String(id ?? ""))).filter((id): id is string => Boolean(id)))];
		if (unique.length) next[providerId] = unique.slice(0, 50);
	}
	return next;
}

export function createCustomModel(providerId: ProviderId, modelId: string, template?: Model<any>): Model<any> {
	const id = sanitizeModelId(modelId);
	if (!id) throw new Error("Enter a model id like anthropic/claude-sonnet-4.6");
	const defaults = PROVIDER_DEFAULTS[providerId] ?? { api: "openai-completions", baseUrl: template?.baseUrl ?? "" };
	return {
		...(template ?? {
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
			reasoning: true,
			...defaults,
		}),
		id,
		name: id,
		provider: providerId,
		api: template?.api ?? defaults.api,
		baseUrl: template?.baseUrl ?? defaults.baseUrl,
		compat: template?.compat ?? defaults.compat,
		reasoning: template?.reasoning ?? true,
		input: template?.input?.includes("text") ? template.input : ["text"],
		// A template from another model cannot tell us this custom id's modalities.
		// Provider metadata can replace this object when it is available.
		inputModalitiesKnown: false,
	} as unknown as Model<any>;
}

export function mergeCustomModels(catalog: Model<any>[], providerId: ProviderId, customIds: string[]): Model<any>[] {
	const template = catalog[0];
	const seen = new Set(catalog.map((model) => model.id));
	const extras: Model<any>[] = [];
	for (const id of customIds) {
		const safe = sanitizeModelId(id);
		if (!safe || seen.has(safe)) continue;
		seen.add(safe);
		extras.push(createCustomModel(providerId, safe, template));
	}
	return [...extras, ...catalog];
}
