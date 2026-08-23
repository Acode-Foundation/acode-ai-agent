import { afterEach, expect, test, vi } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials.ts";
import { ProviderRegistry } from "../src/providers/providerRegistry.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("refreshes a custom OpenRouter model's Pi image capability", async () => {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: {
		name: "Vision New",
		context_length: 200_000,
		architecture: { input_modalities: ["text", "image", "file"] },
	} }), { status: 200 })) as typeof fetch;
	const credentials = new PortableCredentialStore(null);
	await credentials.setApiKey("openrouter", "test-key");
	const registry = new ProviderRegistry(credentials, () => ({ openrouter: ["vendor/vision-new"] }));

	const model = await registry.refreshModel("openrouter", "vendor/vision-new");
	expect(model).toMatchObject({ name: "Vision New", input: ["text", "image"], contextWindow: 200_000 });
	expect(registry.resolveModel("openrouter", "vendor/vision-new")).toBe(model);
});
