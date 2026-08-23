import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { createKvStore, type KvStore } from "./kvStore";

const PREFIX = "acode.ai-agent.model-catalog.v1:";

/** Persists Pi model catalogs using Acode's portable KV/IndexedDB storage. */
export function createModelCatalogStore(ctx?: Acode.PluginContext | null): ModelsStore {
	return modelCatalogStore(createKvStore(ctx));
}

export function modelCatalogStore(kv: KvStore): ModelsStore {
	return {
		read: async (providerId) => validEntry(await kv.get(PREFIX + providerId)),
		write: (providerId, entry) => kv.set(PREFIX + providerId, entry),
		delete: (providerId) => kv.delete(PREFIX + providerId),
	};
}

function validEntry(value: unknown): ModelsStoreEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Partial<ModelsStoreEntry>;
	return Array.isArray(entry.models) ? entry as ModelsStoreEntry : undefined;
}
