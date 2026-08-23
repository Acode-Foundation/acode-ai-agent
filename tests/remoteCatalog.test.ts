import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { afterEach, expect, test, vi } from "vitest";
import { MemoryKvStore } from "../src/platform/kvStore.ts";
import { modelCatalogStore } from "../src/platform/modelCatalogStore.ts";
import { withRemoteCatalog } from "../src/providers/remoteCatalog.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("merges, validates, and restores Pi's cached provider catalog", async () => {
	const baseline = openrouterProvider();
	const existing = baseline.getModels()[0]!;
	const added = { ...existing, id: "vendor/new-vision", name: "New Vision", input: ["text", "image"] };
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({
		[existing.id]: { ...existing, name: "Updated upstream" },
		[added.id]: added,
		invalid: { id: "broken" },
	}), {
		status: 200,
		headers: { ETag: '"catalog-v2"', "Last-Modified": "Fri, 21 Aug 2026 12:29:58 GMT" },
	}));
	globalThis.fetch = fetchMock as typeof fetch;
	const store = modelCatalogStore(new MemoryKvStore());
	const first = withRemoteCatalog(baseline, store);

	await first.refresh(true);
	expect(first.provider.getModels().find((model) => model.id === existing.id)?.name).toBe("Updated upstream");
	expect(first.provider.getModels().find((model) => model.id === added.id)?.input).toEqual(["text", "image"]);
	expect(first.provider.getModels().some((model) => model.id === "broken")).toBe(false);

	const restored = withRemoteCatalog(openrouterProvider(), store);
	await restored.restore();
	expect(restored.provider.getModels().some((model) => model.id === added.id)).toBe(true);
	await restored.refresh();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("revalidates stale catalogs with ETag and keeps cached models on 304", async () => {
	const baseline = openrouterProvider();
	const existing = baseline.getModels()[0]!;
	const store = modelCatalogStore(new MemoryKvStore());
	await store.write("openrouter", { models: [{ ...existing, name: "Cached name" }], checkedAt: 1, etag: '"old"' });
	const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("If-None-Match")).toBe('"old"');
		return new Response(null, { status: 304 });
	});
	globalThis.fetch = fetchMock as typeof fetch;
	const catalog = withRemoteCatalog(baseline, store);

	await catalog.refresh();
	expect(catalog.provider.getModels().find((model) => model.id === existing.id)?.name).toBe("Cached name");
	expect(fetchMock).toHaveBeenCalledOnce();
	expect((await store.read("openrouter"))?.checkedAt).toBeGreaterThan(1);
});
