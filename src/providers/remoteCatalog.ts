import type { Api, Model, ModelsStore, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { nativeFetch } from "../platform/nativeHttp";

const REFRESH_INTERVAL = 4 * 60 * 60 * 1_000;
const FETCH_TIMEOUT = 8_000;

export type RemoteCatalog = {
	provider: Provider;
	restore(): Promise<void>;
	refresh(force?: boolean, signal?: AbortSignal): Promise<void>;
};

/** Browser-portable equivalent of Pi CLI's cached remote-catalog overlay. */
export function withRemoteCatalog(baseline: Provider, store: ModelsStore): RemoteCatalog {
	let remote: Model<Api>[] = [];
	let stored: ModelsStoreEntry | undefined;
	let restored = false;
	let inflight: Promise<void> | undefined;
	const apply = (entry: ModelsStoreEntry | undefined) => {
		stored = entry;
		remote = (entry?.models ?? []).filter(isModel).map((model) => ({ ...model, provider: baseline.id }));
	};
	const restore = async () => {
		if (restored) return;
		apply(await store.read(baseline.id));
		restored = true;
	};
	const refresh = (force = false, signal?: AbortSignal) => {
		inflight ??= (async () => {
			await restore();
			if (signal?.aborted || (!force && stored?.checkedAt && Date.now() - stored.checkedAt < REFRESH_INTERVAL)) return;
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT);
			const abort = () => timeout.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const headers: Record<string, string> = { Accept: "application/json" };
				if (stored?.etag) headers["If-None-Match"] = stored.etag;
				if (stored?.lastModified) headers["If-Modified-Since"] = new Date(stored.lastModified).toUTCString();
				const response = await nativeFetch(`https://pi.dev/api/models/providers/${encodeURIComponent(baseline.id)}`, {
					headers,
					signal: timeout.signal,
				});
				if (response.status === 304) {
					if (stored) await save({ ...stored, checkedAt: Date.now() });
					return;
				}
				if (response.status === 404 || response.status === 501) {
					await save({ ...(stored ?? { models: remote }), checkedAt: Date.now() });
					return;
				}
				if (!response.ok) throw new Error(`Pi model catalog returned HTTP ${response.status}.`);
				const models = parseModels(await response.json(), baseline.id);
				if (!models.length) throw new Error("Pi model catalog returned no valid models.");
				await save({
					models,
					checkedAt: Date.now(),
					etag: response.headers.get("etag") ?? undefined,
					lastModified: parseDate(response.headers.get("last-modified")),
				});
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		})().finally(() => { inflight = undefined; });
		return inflight;
	};
	const save = async (entry: ModelsStoreEntry) => {
		apply(entry);
		await store.write(baseline.id, entry);
	};
	return {
		provider: {
			...baseline,
			getModels: () => mergeModels(baseline.getModels(), remote),
			refreshModels: (context) => context.allowNetwork ? refresh(context.force, context.signal) : restore(),
		},
		restore,
		refresh,
	};
}

function mergeModels(baseline: readonly Model<Api>[], remote: readonly Model<Api>[]): Model<Api>[] {
	const merged = new Map(baseline.map((model) => [model.id, model]));
	for (const model of remote) merged.set(model.id, model);
	return [...merged.values()];
}

function parseModels(value: unknown, provider: string): Model<Api>[] {
	const body = value && typeof value === "object" && "models" in value
		? (value as { models?: unknown }).models
		: value;
	const entries = Array.isArray(body) ? body : body && typeof body === "object" ? Object.values(body) : [];
	return entries.filter(isModel).map((model) => ({ ...model, provider }));
}

function isModel(value: unknown): value is Model<Api> {
	if (!value || typeof value !== "object") return false;
	const model = value as Partial<Model<Api>>;
	return typeof model.id === "string" && typeof model.name === "string" && typeof model.api === "string"
		&& Array.isArray(model.input) && typeof model.contextWindow === "number" && typeof model.maxTokens === "number";
}

function parseDate(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
