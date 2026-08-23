import { createModels, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { antLingProvider } from "@earendil-works/pi-ai/providers/ant-ling";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { qwenTokenPlanProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import type { PortableCredentialStore } from "../platform/credentials";
import type { ProviderId } from "../core/types";
import { nativeFetch } from "../platform/nativeHttp";
import { mergeCatalogOverlay } from "./catalogOverlay";
import { createCustomModel, mergeCustomModels, sanitizeModelId } from "./customModels";
import { portableCodexOAuth, portableXaiOAuth } from "./portableOAuth";

export type ProviderDescriptor = {
	id: ProviderId;
	name: string;
	hint: string;
	keyPlaceholder?: string;
	keyUrl?: string;
	apiKey: boolean;
	subscriptionLabel?: string;
};

export const PROVIDERS: readonly ProviderDescriptor[] = [
	{ id: "openrouter", name: "OpenRouter", hint: "One key, hundreds of models", keyPlaceholder: "sk-or-v1-…", keyUrl: "https://openrouter.ai/keys", apiKey: true },
	{ id: "openai", name: "OpenAI", hint: "Direct API key", keyPlaceholder: "sk-proj-…", keyUrl: "https://platform.openai.com/api-keys", apiKey: true },
	{ id: "openai-codex", name: "Codex", hint: "ChatGPT Plus / Pro", apiKey: false, subscriptionLabel: "Connect ChatGPT subscription" },
	{ id: "anthropic", name: "Anthropic", hint: "Direct API key", keyPlaceholder: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys", apiKey: true },
	{ id: "google", name: "Google Gemini", hint: "Google AI Studio key", keyPlaceholder: "AIza…", keyUrl: "https://aistudio.google.com/apikey", apiKey: true },
	{ id: "xai", name: "xAI", hint: "API key or Grok subscription", keyPlaceholder: "xai-…", keyUrl: "https://console.x.ai", apiKey: true, subscriptionLabel: "Connect Grok / X subscription" },
	{ id: "groq", name: "Groq", hint: "Low-latency inference", keyPlaceholder: "gsk_…", keyUrl: "https://console.groq.com/keys", apiKey: true },
	{ id: "deepseek", name: "DeepSeek", hint: "Direct API key", keyPlaceholder: "sk-…", keyUrl: "https://platform.deepseek.com/api_keys", apiKey: true },
	{ id: "cerebras", name: "Cerebras", hint: "Fast inference", keyPlaceholder: "csk-…", keyUrl: "https://cloud.cerebras.ai", apiKey: true },
	{ id: "fireworks", name: "Fireworks", hint: "Open models at speed", keyPlaceholder: "fw_…", keyUrl: "https://fireworks.ai/account/api-keys", apiKey: true },
	{ id: "together", name: "Together", hint: "Open-model inference", keyPlaceholder: "…", keyUrl: "https://api.together.xyz/settings/api-keys", apiKey: true },
	{ id: "moonshotai", name: "Moonshot / Kimi", hint: "Kimi API key", keyPlaceholder: "sk-…", keyUrl: "https://platform.moonshot.ai", apiKey: true },
	{ id: "minimax", name: "MiniMax", hint: "Direct API key", keyPlaceholder: "…", keyUrl: "https://www.minimax.io", apiKey: true },
	{ id: "zai", name: "Z.AI", hint: "GLM coding models", keyPlaceholder: "…", keyUrl: "https://z.ai", apiKey: true },
	{ id: "kimi-coding", name: "Kimi Coding", hint: "Kimi coding plan", keyPlaceholder: "sk-…", keyUrl: "https://www.kimi.com", apiKey: true },
	{ id: "qwen-token-plan", name: "Qwen Token Plan", hint: "Alibaba token plan", keyPlaceholder: "sk-…", keyUrl: "https://www.alibabacloud.com", apiKey: true },
	{ id: "ant-ling", name: "Ant Ling", hint: "Direct API key", keyPlaceholder: "…", keyUrl: "https://www.ant-ling.com", apiKey: true },
	{ id: "xiaomi", name: "Xiaomi", hint: "MiMo API key", keyPlaceholder: "…", keyUrl: "https://platform.xiaomimimo.com", apiKey: true },
] as const;

export class ProviderRegistry {
	readonly models: MutableModels;
	#customModels: () => Record<string, string[]>;
	#overrides = new Map<string, Model<any>>();

	constructor(credentials: PortableCredentialStore, customModels: () => Record<string, string[]> = () => ({})) {
		this.#customModels = customModels;
		const models = createModels({
			credentials,
			authContext: {
				env: async () => undefined,
				fileExists: async () => false,
			},
		});
		for (const provider of portableProviders()) models.setProvider(provider);
		this.models = withNativeFetch(models);
	}

	register(provider: Provider): () => void {
		this.models.setProvider(provider);
		return () => this.models.deleteProvider(provider.id);
	}

	getModels(providerId: ProviderId): Model<any>[] {
		const catalog = mergeCatalogOverlay(
			providerId,
			[...this.models.getModels(providerId)].filter((model) => model.input.includes("text")),
		).sort((left, right) => left.name.localeCompare(right.name));
		return mergeCustomModels(catalog, providerId, this.#customModels()[providerId] ?? [])
			.map((model) => this.#overrides.get(`${providerId}:${model.id}`) ?? model);
	}

	resolveModel(providerId: ProviderId, modelId: string): Model<any> {
		const id = sanitizeModelId(modelId);
		const override = id ? this.#overrides.get(`${providerId}:${id}`) : undefined;
		if (override) return override;
		const listed = id ? this.getModels(providerId).find((model) => model.id === id) : undefined;
		if (listed) return listed;
		const catalog = this.models.getModel(providerId, modelId);
		if (catalog) return catalog;
		if (id) return createCustomModel(providerId, id, this.models.getModels(providerId)[0]);
		const fallback = this.getModels(providerId)[0];
		if (!fallback) throw new Error(`No models are available for ${providerId}.`);
		return fallback;
	}

	async refreshModel(providerId: ProviderId, modelId: string): Promise<Model<any>> {
		const model = this.resolveModel(providerId, modelId);
		if (providerId !== "openrouter") return model;
		const auth = await this.models.getAuth(providerId);
		const headers = auth?.auth.apiKey ? { Authorization: `Bearer ${auth.auth.apiKey}` } : undefined;
		const path = model.id.split("/").map(encodeURIComponent).join("/");
		const response = await nativeFetch(`https://openrouter.ai/api/v1/model/${path}`, { headers });
		if (!response.ok) throw new Error(`OpenRouter model metadata returned HTTP ${response.status}.`);
		const data = (await response.json() as { data?: { name?: unknown; context_length?: unknown; architecture?: { input_modalities?: unknown } } }).data;
		const inputs = data?.architecture?.input_modalities;
		if (!Array.isArray(inputs)) return model;
		const refreshed = {
			...model,
			name: typeof data?.name === "string" ? data.name : model.name,
			contextWindow: typeof data?.context_length === "number" && data.context_length > 0 ? data.context_length : model.contextWindow,
			input: inputs.includes("image") ? ["text", "image"] : ["text"],
			inputModalitiesKnown: true,
		} as unknown as Model<any>;
		this.#overrides.set(`${providerId}:${model.id}`, refreshed);
		return refreshed;
	}
}

function portableProviders(): Provider[] {
	const xai = xaiProvider();
	const codex = openaiCodexProvider();
	return [
		openrouterProvider(),
		openaiProvider(),
		{ ...codex, auth: { ...codex.auth, oauth: portableCodexOAuth } },
		anthropicProvider(),
		googleProvider(),
		{ ...xai, auth: { ...xai.auth, oauth: portableXaiOAuth } },
		groqProvider(),
		deepseekProvider(),
		cerebrasProvider(),
		fireworksProvider(),
		togetherProvider(),
		moonshotaiProvider(),
		minimaxProvider(),
		zaiProvider(),
		kimiCodingProvider(),
		qwenTokenPlanProvider(),
		antLingProvider(),
		xiaomiProvider(),
	];
}

function withNativeFetch(models: MutableModels): MutableModels {
	const streamSimple = models.streamSimple.bind(models);
	const completeSimple = models.completeSimple.bind(models);
	models.streamSimple = (model, context, options) => streamSimple(model, context, { ...options, fetch: nativeFetch });
	models.completeSimple = (model, context, options) => completeSimple(model, context, { ...options, fetch: nativeFetch });
	return models;
}
