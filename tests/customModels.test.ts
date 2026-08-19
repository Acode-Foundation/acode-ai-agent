import { expect, test } from "vitest";
import { createCustomModel, mergeCustomModels, sanitizeCustomModels, sanitizeModelId } from "../src/providers/customModels.ts";

test("accepts OpenRouter-style slugs and rejects junk", () => {
	expect(sanitizeModelId(" anthropic/claude-sonnet-4.6 ")).toBe("anthropic/claude-sonnet-4.6");
	expect(sanitizeModelId("openai/gpt-5.4:free")).toBe("openai/gpt-5.4:free");
	expect(sanitizeModelId("")).toBeUndefined();
	expect(sanitizeModelId("../secret")).toBeUndefined();
	expect(sanitizeModelId("https://evil")).toBeUndefined();
});

test("creates a streamable OpenRouter model from an id", () => {
	const model = createCustomModel("openrouter", "vendor/new-model-9");
	expect(model.id).toBe("vendor/new-model-9");
	expect(model.provider).toBe("openrouter");
	expect(model.api).toBe("openai-completions");
	expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
	expect(model.compat?.thinkingFormat).toBe("openrouter");
	expect(model.input.includes("text")).toBe(true);
});

test("puts custom ids ahead of the catalog without duplicating bundled ones", () => {
	const catalog = [{ id: "openrouter/auto", name: "Auto", api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }];
	const merged = mergeCustomModels(catalog as any, "openrouter", ["vendor/new", "openrouter/auto", "bad id"]);
	expect(merged.map((model) => model.id)).toEqual(["vendor/new", "openrouter/auto"]);
});

test("drops invalid persisted custom models", () => {
	expect(sanitizeCustomModels({ openrouter: ["ok/model", "", 12] })).toEqual({ openrouter: ["ok/model"] });
});
