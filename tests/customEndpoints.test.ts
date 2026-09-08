import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { PortableCredentialStore } from "../src/platform/credentials.ts";
import {
  allocateProviderId,
  BUILTIN_PROVIDER_IDS,
  createOpenAICompatibleProvider,
  customEndpointModel,
  finalizeCustomEndpoint,
  isLocalUrl,
  isLoopbackUrl,
  isReservedProviderId,
  LOCAL_ENDPOINT_PRESETS,
  LOCAL_OPENAI_COMPAT,
  modelsUrl,
  normalizeOpenAIBaseUrl,
  parseOpenAIModelIds,
  probeOpenAIModels,
  sanitizeCustomEndpoints,
  slugifyProviderId,
  upsertCustomEndpoint,
} from "../src/providers/customEndpoints.ts";
import { PROVIDERS, ProviderRegistry } from "../src/providers/providerRegistry.ts";

test("reserved ids match the built-in provider list", () => {
  expect([...BUILTIN_PROVIDER_IDS].sort()).toEqual(
    [...PROVIDERS.map((provider) => provider.id)].sort(),
  );
});

test("normalizes OpenAI-compatible base URLs and rejects unsafe ones", () => {
  expect(normalizeOpenAIBaseUrl("http://192.168.1.10:11434")).toBe("http://192.168.1.10:11434/v1");
  expect(normalizeOpenAIBaseUrl("http://192.168.1.10:11434/v1/")).toBe(
    "http://192.168.1.10:11434/v1",
  );
  expect(normalizeOpenAIBaseUrl("https://proxy.example.com/openai/v1")).toBe(
    "https://proxy.example.com/openai/v1",
  );
  expect(normalizeOpenAIBaseUrl("http://host:8080/v1/chat/completions")).toBe(
    "http://host:8080/v1",
  );
  expect(normalizeOpenAIBaseUrl("https://user:pass@evil.example/v1")).toBeUndefined();
  expect(normalizeOpenAIBaseUrl("http://host/v1?x=1")).toBeUndefined();
  expect(normalizeOpenAIBaseUrl("javascript:alert(1)")).toBeUndefined();
  expect(modelsUrl("http://192.168.1.10:11434/v1")).toBe("http://192.168.1.10:11434/v1/models");
});

test("treats loopback and LAN hosts as local", () => {
  expect(isLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
  expect(isLoopbackUrl("http://192.168.1.10:11434/v1")).toBe(false);
  expect(isLocalUrl("http://localhost:11434/v1")).toBe(true);
  expect(isLocalUrl("http://10.0.0.8:1234/v1")).toBe(true);
  expect(isLocalUrl("http://172.16.4.2/v1")).toBe(true);
  expect(isLocalUrl("http://macbook.local:1234/v1")).toBe(true);
  expect(isLocalUrl("https://openrouter.ai/api/v1")).toBe(false);
});

test("allocates ids without colliding with built-ins", () => {
  expect(slugifyProviderId("Ollama Local")).toBe("ollama-local");
  expect(isReservedProviderId("openai")).toBe(true);
  expect(allocateProviderId("OpenAI", [])).toBe("openai-2");
  expect(allocateProviderId("Ollama", ["ollama"])).toBe("ollama-2");
  expect(allocateProviderId("Proxy", ["proxy"], "my-proxy")).toBe("my-proxy");
});

test("parses OpenAI, Ollama, and string-list model catalogs", () => {
  expect(
    parseOpenAIModelIds({ data: [{ id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }] }),
  ).toEqual(["llama3.1:8b", "qwen2.5-coder:7b"]);
  expect(parseOpenAIModelIds({ models: [{ name: "gpt-oss:20b" }] })).toEqual(["gpt-oss:20b"]);
  expect(parseOpenAIModelIds(["ok/model", "../secret"])).toEqual(["ok/model"]);
});

test("drops invalid persisted endpoints and keeps a safe catalog", () => {
  expect(
    sanitizeCustomEndpoints([
      { id: "openai", name: "Nope", baseUrl: "http://127.0.0.1:11434/v1", models: ["x"] },
      { name: "Ollama", baseUrl: "http://192.168.1.5:11434", models: ["llama3.1:8b", "bad id"] },
      { name: "", baseUrl: "http://192.168.1.5:11434/v1" },
    ]),
  ).toEqual([
    {
      id: "ollama",
      name: "Ollama",
      baseUrl: "http://192.168.1.5:11434/v1",
      models: ["llama3.1:8b"],
      fetchModels: true,
      vision: true,
      reasoning: true,
      localCompat: true,
    },
  ]);
});

test("finalize and upsert preserve an existing id", () => {
  const first = finalizeCustomEndpoint(
    { name: "LM Studio", baseUrl: "http://10.0.0.4:1234/v1", models: "local-model" },
    [],
  );
  expect(first.id).toBe("lm-studio");
  const updated = finalizeCustomEndpoint(
    { ...first, name: "Home GPU", models: "local-model\nother" },
    [first],
  );
  expect(updated.id).toBe("lm-studio");
  expect(updated.name).toBe("Home GPU");
  expect(updated.models).toEqual(["local-model", "other"]);
  expect(upsertCustomEndpoint([first], updated).map((endpoint) => endpoint.id)).toEqual([
    "lm-studio",
  ]);
});

test("builds a streamable openai-completions provider from the endpoint", () => {
  const endpoint = finalizeCustomEndpoint(
    {
      name: "Ollama",
      baseUrl: "http://192.168.1.10:11434/v1",
      models: "gpt-oss:20b",
      localCompat: true,
      vision: false,
      reasoning: true,
    },
    [],
  );
  const model = customEndpointModel(endpoint, "gpt-oss:20b");
  expect(model.api).toBe("openai-completions");
  expect(model.provider).toBe("ollama");
  expect(model.baseUrl).toBe("http://192.168.1.10:11434/v1");
  expect(model.compat).toEqual(LOCAL_OPENAI_COMPAT);
  expect(model.input).toEqual(["text"]);
  const provider = createOpenAICompatibleProvider(endpoint);
  expect(provider.id).toBe("ollama");
  expect(provider.getModels().map((item) => item.id)).toEqual(["gpt-oss:20b"]);
});

test("local presets use LAN IPs and llama.cpp / vLLM ports", () => {
  expect(LOCAL_ENDPOINT_PRESETS.map((preset) => preset.name)).toEqual([
    "llama.cpp",
    "vLLM",
    "LM Studio",
    "Ollama",
  ]);
  expect(LOCAL_ENDPOINT_PRESETS[0]?.baseUrl).toBe("http://192.168.1.10:8080/v1");
  expect(LOCAL_ENDPOINT_PRESETS[1]?.baseUrl).toBe("http://192.168.1.10:8000/v1");
  for (const preset of LOCAL_ENDPOINT_PRESETS) {
    expect(isLocalUrl(preset.baseUrl)).toBe(true);
    expect(isLoopbackUrl(preset.baseUrl)).toBe(false);
  }
});

test("registry lists and resolves a custom llama.cpp endpoint", () => {
  const endpoint = finalizeCustomEndpoint(
    {
      name: "llama.cpp",
      baseUrl: "http://192.168.1.10:8080/v1",
      models: "qwen2.5-coder",
      vision: false,
      reasoning: false,
    },
    [],
  );
  const registry = new ProviderRegistry(
    new PortableCredentialStore(null),
    () => ({}),
    new InMemoryModelsStore(),
    () => [endpoint],
  );
  expect(registry.descriptors().find((item) => item.id === "llama-cpp")).toMatchObject({
    id: "llama-cpp",
    name: "llama.cpp",
    hint: "http://192.168.1.10:8080/v1",
  });
  const model = registry.resolveModel("llama-cpp", "qwen2.5-coder");
  expect(model.api).toBe("openai-completions");
  expect(model.baseUrl).toBe("http://192.168.1.10:8080/v1");
  expect(model.compat).toEqual(LOCAL_OPENAI_COMPAT);
  expect(registry.getModels("llama-cpp").map((item) => item.id)).toEqual(["qwen2.5-coder"]);
});

test("probeOpenAIModels reads /models with an optional bearer token", async () => {
  const requests: Array<{ url: string; auth?: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ url: request.url, auth: request.headers.get("Authorization") });
    return Response.json({ data: [{ id: "llama3.1:8b" }, { id: "bad id" }] });
  }) as typeof fetch;
  try {
    await expect(probeOpenAIModels("http://192.168.1.10:11434", "sk-test")).resolves.toEqual([
      "llama3.1:8b",
    ]);
    expect(requests).toEqual([
      { url: "http://192.168.1.10:11434/v1/models", auth: "Bearer sk-test" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
