import type { Models } from "@earendil-works/pi-ai";
import type { AgentSettings } from "../../core/types";
import { authFromResolved } from "./nativeSearch";
import type { WebAuth, WebSearchContext } from "./types";

export function createWebSearchContext(options: {
	models: Models;
	settings: () => AgentSettings;
}): WebSearchContext {
	return {
		currentProviderId: () => options.settings().providerId,
		currentModelId: () => options.settings().modelId,
		resolveAuth: async (providerId, preferredModelId) => resolveAuth(options.models, providerId, preferredModelId),
	};
}

async function resolveAuth(models: Models, providerId: string, preferredModelId?: string): Promise<WebAuth | undefined> {
	const catalog = models.getModels(providerId);
	const model = (preferredModelId ? catalog.find((item) => item.id === preferredModelId) : undefined) ?? catalog[0];
	if (!model) return undefined;
	try {
		const resolved = await models.getAuth(model);
		if (!resolved?.auth) return undefined;
		if (!resolved.auth.apiKey && !Object.keys(resolved.auth.headers ?? {}).length) return undefined;
		return authFromResolved(resolved.auth, model.id);
	} catch {
		return undefined;
	}
}
