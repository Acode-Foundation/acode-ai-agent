import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { PortableCredentialStore } from "../src/platform/credentials";
import { ProviderRegistry } from "../src/providers/providerRegistry";

let registry: ProviderRegistry;
let hostFetch: ReturnType<typeof vi.fn>;
let httpStream: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const credentials = new PortableCredentialStore(null);
  await credentials.setApiKey("openrouter", "fixture-key");
  await credentials.setApiKey("openai", "fixture-key");
  registry = new ProviderRegistry(credentials);
  hostFetch = vi.fn(() => {
    throw new Error("Provider request reached host fetch");
  });
  httpStream = vi.fn();
  vi.stubGlobal("fetch", hostFetch);
  vi.stubGlobal("system", { httpStream });
});

afterEach(() => {
  try {
    expect(hostFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(hostFetch);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each(["stream", "complete", "streamSimple", "completeSimple"] as const)(
  "%s routes SDK chat requests through native HTTP",
  async (method) => {
    const model = registry.models
      .getModels("openrouter")
      .find((model) => model.api === "openai-completions")!;
    httpStream.mockImplementation(chatResponse);
    const result = registry.models[method](
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { maxRetries: 0 },
    );
    const response = await ("result" in result ? result.result() : result);
    expect(response.stopReason).toBe("stop");
    expect(response.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello" }),
    );
    expect(httpStream).toHaveBeenCalledOnce();
  },
);

test("preserves an explicit fetch for non-Google providers", async () => {
  const model = registry.models
    .getModels("openrouter")
    .find((model) => model.api === "openai-completions")!;
  const requestFetch = vi.fn(chatResponse);
  const response = await registry.models.completeSimple(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
    { fetch: requestFetch, maxRetries: 0 },
  );
  expect(response.stopReason).toBe("stop");
  expect(requestFetch).toHaveBeenCalledOnce();
  expect(httpStream).not.toHaveBeenCalled();
});

test("image generation routes the SDK request through native HTTP", async () => {
  httpStream.mockImplementation(async () =>
    Response.json({
      id: "image",
      choices: [
        { message: { images: [{ image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] } },
      ],
    }),
  );
  const model = registry.models.getModelsOfType("image", "openrouter")[0]!;
  const response = await registry.models.generateImages(
    model,
    {
      input: [{ type: "text", text: "Draw a tree" }],
    },
    { maxRetries: 0 },
  );
  expect(response.stopReason).toBe("stop");
  expect(response.output).toEqual([{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
  expect(httpStream).toHaveBeenCalledOnce();
});

test("classification routes the SDK request through native HTTP", async () => {
  httpStream.mockImplementation(async () =>
    Response.json({
      answers: [{ name: "valid", type: "predicate", probability: 0.9 }],
    }),
  );
  const model = registry.models.getModelsOfType("classifier", "openai")[0]!;
  const response = await registry.models.classify(
    model,
    {
      state: { text: "Hello" },
      questions: {
        valid: {
          type: "bool",
          instructions: "Is this a greeting?",
          criteria: { true: "Yes", false: "No" },
        },
      },
    },
    { maxRetries: 0 },
  );
  expect(response.stopReason).toBe("stop");
  expect(response.answers.valid).toEqual({ type: "bool", probability: 0.9 });
  expect(httpStream).toHaveBeenCalledOnce();
});

test("deferred polling and cancellation use native HTTP and retain cancellation signals", async () => {
  const provider = registry.models.getProvider("openrouter")!;
  const model = provider.getModels().find((model) => model.api === "openai-completions")!;
  const handle = { provider: model.provider, modelId: model.id, api: model.api, id: "deferred" };
  const controller = new AbortController();
  httpStream.mockImplementation(chatResponse);
  // No bundled provider currently implements deferred requests; exercise the SDK dispatch.
  registry.models.setProvider({
    ...provider,
    fetchDeferred(requestModel, requestHandle, options) {
      expect(requestModel.id).toBe(model.id);
      expect(requestHandle).toBe(handle);
      expect(options?.signal).toBe(controller.signal);
      return provider.streamSimple(
        requestModel,
        normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }),
        { ...options, maxRetries: 0 },
      );
    },
    async cancelDeferred(requestModel, requestHandle, options) {
      expect(requestModel.id).toBe(model.id);
      expect(requestHandle).toBe(handle);
      expect(options?.signal).toBe(controller.signal);
      await (options?.fetch ?? globalThis.fetch)("https://provider.test/deferred", {
        signal: options?.signal,
      });
    },
  });
  const options = { signal: controller.signal };
  expect(
    (await registry.harnessModels.streamDeferred(model, handle, options).result()).stopReason,
  ).toBe("stop");
  expect((await registry.harnessModels.fetchDeferred(model, handle, options)).stopReason).toBe(
    "stop",
  );
  await registry.harnessModels.cancelDeferred(model, handle, options);
  expect(httpStream).toHaveBeenCalledTimes(3);
});

async function chatResponse() {
  return new Response(
    `data: ${JSON.stringify({ id: "chat", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
