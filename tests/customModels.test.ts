import assert from "node:assert/strict";
import test from "node:test";
import { createCustomModel, mergeCustomModels, sanitizeCustomModels, sanitizeModelId } from "../src/providers/customModels.ts";

test("accepts OpenRouter-style slugs and rejects junk", () => {
	assert.equal(sanitizeModelId(" anthropic/claude-sonnet-4.6 "), "anthropic/claude-sonnet-4.6");
	assert.equal(sanitizeModelId("openai/gpt-5.4:free"), "openai/gpt-5.4:free");
	assert.equal(sanitizeModelId(""), undefined);
	assert.equal(sanitizeModelId("../secret"), undefined);
	assert.equal(sanitizeModelId("https://evil"), undefined);
});

test("creates a streamable OpenRouter model from an id", () => {
	const model = createCustomModel("openrouter", "vendor/new-model-9");
	assert.equal(model.id, "vendor/new-model-9");
	assert.equal(model.provider, "openrouter");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "https://openrouter.ai/api/v1");
	assert.equal(model.compat?.thinkingFormat, "openrouter");
	assert.ok(model.input.includes("text"));
});

test("puts custom ids ahead of the catalog without duplicating bundled ones", () => {
	const catalog = [{ id: "openrouter/auto", name: "Auto", api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }];
	const merged = mergeCustomModels(catalog as any, "openrouter", ["vendor/new", "openrouter/auto", "bad id"]);
	assert.deepEqual(merged.map((model) => model.id), ["vendor/new", "openrouter/auto"]);
});

test("drops invalid persisted custom models", () => {
	assert.deepEqual(sanitizeCustomModels({ openrouter: ["ok/model", "", 12] }), { openrouter: ["ok/model"] });
});
