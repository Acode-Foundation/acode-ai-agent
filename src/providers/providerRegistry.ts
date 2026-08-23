import { createModels, InMemoryModelsStore, type Model, type ModelsStore, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { antLingProvider } from "@earendil-works/pi-ai/providers/ant-ling";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
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
import {
	portableAnthropicOAuth,
	portableCodexOAuth,
	portableGitHubCopilotOAuth,
	portableKimiOAuth,
	portableOpenRouterOAuth,
	portableXaiOAuth,
	refreshPortableCodexModels,
} from "./portableOAuth";
import { withRemoteCatalog, type RemoteCatalog } from "./remoteCatalog";

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
	{ id: "openrouter", name: "OpenRouter", hint: "API key or OpenRouter account", keyPlaceholder: "sk-or-v1-…", keyUrl: "https://openrouter.ai/keys", apiKey: true, subscriptionLabel: "Sign in with OpenRouter" },
	{ id: "openai", name: "OpenAI", hint: "Direct API key", keyPlaceholder: "sk-proj-…", keyUrl: "https://platform.openai.com/api-keys", apiKey: true },
	{ id: "openai-codex", name: "Codex", hint: "ChatGPT subscription", apiKey: false, subscriptionLabel: "Sign in with ChatGPT" },
	{ id: "anthropic", name: "Anthropic", hint: "API key or Claude Pro / Max", keyPlaceholder: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys", apiKey: true, subscriptionLabel: "Connect Claude Pro / Max" },
	{ id: "github-copilot", name: "GitHub Copilot", hint: "Copilot subscription", apiKey: false, subscriptionLabel: "Connect GitHub Copilot" },
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
	{ id: "kimi-coding", name: "Kimi Coding", hint: "API key or Kimi Code subscription", keyPlaceholder: "sk-…", keyUrl: "https://www.kimi.com", apiKey: true, subscriptionLabel: "Connect Kimi Code" },
	{ id: "qwen-token-plan", name: "Qwen Token Plan", hint: "Alibaba token plan", keyPlaceholder: "sk-…", keyUrl: "https://www.alibabacloud.com", apiKey: true },
	{ id: "ant-ling", name: "Ant Ling", hint: "Direct API key", keyPlaceholder: "…", keyUrl: "https://www.ant-ling.com", apiKey: true },
	{ id: "xiaomi", name: "Xiaomi", hint: "MiMo API key", keyPlaceholder: "…", keyUrl: "https://platform.xiaomimimo.com", apiKey: true },
] as const;

export class ProviderRegistry {
	readonly models: MutableModels;
	#credentials: PortableCredentialStore;
	#customModels: () => Record<string, string[]>;
	#overrides = new Map<string, Model<any>>();
	#catalogs = new Map<string, RemoteCatalog>();
	#availableModelIds = new Map<string, ReadonlySet<string>>();

	constructor(
		credentials: PortableCredentialStore,
		customModels: () => Record<string, string[]> = () => ({}),
		catalogStore: ModelsStore = new InMemoryModelsStore(),
	) {
		this.#credentials = credentials;
		this.#customModels = customModels;
		const models = createModels({
			credentials,
			modelsStore: catalogStore,
			authContext: {
				env: async () => undefined,
				fileExists: async () => false,
			},
		});
		for (const provider of portableProviders()) {
			const catalog = withRemoteCatalog(provider, catalogStore);
			this.#catalogs.set(provider.id, catalog);
			models.setProvider(catalog.provider);
		}
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
		const available = this.#availableModelIds.get(providerId);
		return mergeCustomModels(catalog, providerId, this.#customModels()[providerId] ?? [])
			.map((model) => this.#overrides.get(`${providerId}:${model.id}`) ?? model)
			.filter((model) => !available || available.has(model.id));
	}

	/** Cache pi's credential-specific model policy for the synchronous mobile picker. */
	async refreshModelAvailability(providerId: ProviderId): Promise<Model<any>[]> {
		let credential = await this.#credentials.read(providerId);
		if (providerId === "openai-codex" && credential?.type === "oauth" && !Array.isArray(credential.availableModelIds)) {
			try {
				credential = await this.#credentials.modify(providerId, async (current) => current?.type === "oauth"
					? refreshPortableCodexModels(current)
					: undefined);
			} catch (error) {
				console.warn("Codex account model availability could not be refreshed", error);
			}
		}
		const provider = this.models.getProvider(providerId);
		if (credential?.type !== "oauth" || !provider?.filterModels) {
			this.#availableModelIds.delete(providerId);
			return this.getModels(providerId);
		}
		const available = await this.models.getAvailable(providerId);
		this.#availableModelIds.set(providerId, new Set(available.map((model) => model.id)));
		return this.getModels(providerId);
	}

	resolveModel(providerId: ProviderId, modelId: string): Model<any> {
		const id = sanitizeModelId(modelId);
		const override = id ? this.#overrides.get(`${providerId}:${id}`) : undefined;
		const available = this.#availableModelIds.get(providerId);
		if (override && (!available || available.has(override.id))) return override;
		const listed = id ? this.getModels(providerId).find((model) => model.id === id) : undefined;
		if (listed) return listed;
		if (available) {
			const fallback = this.getModels(providerId)[0];
			if (!fallback) throw new Error(`No models are available for this ${providerId} account.`);
			return fallback;
		}
		const catalog = this.models.getModel(providerId, modelId);
		if (catalog) return catalog;
		if (id) return createCustomModel(providerId, id, this.models.getModels(providerId)[0]);
		const fallback = this.getModels(providerId)[0];
		if (!fallback) throw new Error(`No models are available for ${providerId}.`);
		return fallback;
	}

	async restoreCatalogs(): Promise<void> {
		await Promise.all([...this.#catalogs.values()].map((catalog) => catalog.restore()));
	}

	async refreshCatalog(providerId: ProviderId, force = false): Promise<void> {
		await this.#catalogs.get(providerId)?.refresh(force);
	}

	async refreshModel(providerId: ProviderId, modelId: string, force = false): Promise<Model<any>> {
		try {
			await this.refreshCatalog(providerId, force);
		} catch (error) {
			console.warn(`${providerId} model catalog could not be refreshed`, error);
		}
		const model = this.resolveModel(providerId, modelId);
		const metadataKnown = (model as Model<any> & { inputModalitiesKnown?: boolean }).inputModalitiesKnown;
		if (providerId !== "openrouter" || metadataKnown !== false) return model;
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
	const openrouter = openrouterProvider();
	const anthropic = anthropicProvider();
	const githubCopilot = githubCopilotProvider();
	const xai = xaiProvider();
	const codex = openaiCodexProvider();
	const kimi = kimiCodingProvider();
	return [
		{ ...openrouter, auth: { ...openrouter.auth, oauth: portableOpenRouterOAuth } },
		openaiProvider(),
		{ ...codex, auth: { ...codex.auth, oauth: portableCodexOAuth }, filterModels: filterOAuthAccountModels },
		{ ...anthropic, auth: { ...anthropic.auth, oauth: portableAnthropicOAuth } },
		{ ...githubCopilot, auth: { ...githubCopilot.auth, oauth: portableGitHubCopilotOAuth } },
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
		{ ...kimi, auth: { ...kimi.auth, oauth: portableKimiOAuth } },
		qwenTokenPlanProvider(),
		antLingProvider(),
		xiaomiProvider(),
	];
}

function filterOAuthAccountModels(models: readonly Model<any>[], credential: unknown): readonly Model<any>[] {
	if (!credential || typeof credential !== "object" || (credential as { type?: unknown }).type !== "oauth") return models;
	const ids = (credential as { availableModelIds?: unknown }).availableModelIds;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return models;
	const available = new Set(ids);
	return models.filter((model) => available.has(model.id));
}

function withNativeFetch(models: MutableModels): MutableModels {
	const streamSimple = models.streamSimple.bind(models);
	const completeSimple = models.completeSimple.bind(models);
	models.streamSimple = (model, context, options) => streamSimple(model, context, { ...options, fetch: nativeFetch });
	models.completeSimple = (model, context, options) => completeSimple(model, context, { ...options, fetch: nativeFetch });
	return models;
}
