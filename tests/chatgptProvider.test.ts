import { afterEach, expect, test, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { PortableCredentialStore } from "../src/platform/credentials";
import { ProviderRegistry } from "../src/providers/providerRegistry";
import { chatgptPayload } from "../src/providers/chatgptProvider";

afterEach(() => vi.unstubAllGlobals());

test("disconnect stops concurrent ChatGPT requests before revoking the refresh token", async () => {
  const credentials = new PortableCredentialStore(null);
  await credentials.modify("chatgpt", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Number.MAX_SAFE_INTEGER,
    clientId: "issued",
    scopes: ["chatgpt.tokens.use.direct"],
  }));
  const registry = new ProviderRegistry(credentials);
  const model = registry.models.getModels("chatgpt")[0]!;
  const signals: AbortSignal[] = [];
  vi.stubGlobal("system", {
    httpStream: async (url: string, options: { signal: AbortSignal }) => {
      if (url.endsWith("/responses")) {
        signals.push(options.signal);
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          }),
        );
      }
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      return new Response(null, { status: 200 });
    },
  });
  const context = {
    messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }],
  };
  const first = registry.models.completeSimple(model, context);
  const second = registry.models.completeSimple(model, context);
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  expect(await registry.chatgptAccount.disconnect()).toBe(true);
  expect((await first).stopReason).toBe("aborted");
  expect((await second).stopReason).toBe("aborted");
  expect(await credentials.read("chatgpt")).toBeUndefined();
});

function sse(events: Record<string, unknown>[]): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

test("ChatGPT agent requests stream public Responses with namespaced tools and replay their results", async () => {
  const credentials = new PortableCredentialStore(null);
  await credentials.modify("chatgpt", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 3600_000,
    clientId: "issued",
    scopes: ["chatgpt.tokens.use.direct"],
    availableModels: [{ id: "gpt-5.4", name: "My available model" }],
    availableModelsFetchedAt: Date.now(),
  }));
  const registry = new ProviderRegistry(credentials);
  const catalog = await registry.refreshModelAvailability("chatgpt");
  expect(catalog.map((model) => model.id)).toEqual(["gpt-5.4"]);
  expect(catalog[0]?.name).toBe("My available model");
  const model = registry.resolveModel("chatgpt", "gpt-5.4");
  const requests: Record<string, unknown>[] = [];
  const call = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    namespace: "acode",
    name: "read",
    arguments: '{"path":"README.md"}',
    status: "completed",
  };
  vi.stubGlobal("system", {
    httpStream: async (
      url: string,
      options: { body?: string; headers: Record<string, string> },
    ) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(options.headers.authorization).toBe("Bearer access");
      requests.push(JSON.parse(options.body!));
      const output =
        requests.length === 1
          ? call
          : {
              type: "message",
              id: "msg_final",
              role: "assistant",
              content: [{ type: "output_text", text: "Read complete.", annotations: [] }],
              status: "completed",
            };
      return sse([
        { type: "response.output_item.added", output_index: 0, item: output },
        { type: "response.output_item.done", output_index: 0, item: output },
        {
          type: "response.completed",
          response: {
            id: "response",
            status: "completed",
            output: [output],
            usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          },
        },
      ]);
    },
  });
  const tools = [
    {
      name: "read",
      description: "Read a project file",
      parameters: Type.Object({ path: Type.String() }),
    },
  ];
  const user = { role: "user" as const, content: "Read README.md", timestamp: Date.now() };
  const first = await registry.models.completeSimple(
    model,
    { systemPrompt: "Use project tools.", messages: [user], tools },
    {
      maxTokens: 100,
      samplingParams: { temperature: 0.5 },
      cacheRetention: "long",
    },
  );
  expect(first.stopReason).toBe("toolUse");
  expect(first.content[0]).toMatchObject({
    type: "toolCall",
    name: "read",
    arguments: { path: "README.md" },
    namespace: "acode",
  });
  const toolCall = first.content.find((block) => block.type === "toolCall")!;
  if (toolCall.type !== "toolCall") throw new Error("Missing tool call");
  const second = await registry.models.completeSimple(model, {
    systemPrompt: "Use project tools.",
    tools,
    messages: [
      user,
      first,
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: "read",
        content: [{ type: "text", text: "Project documentation" }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
  });
  expect(second.stopReason).toBe("stop");
  expect(second.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Read complete." }),
  );
  expect(requests[0]).toMatchObject({
    store: false,
    stream: true,
    tools: [{ type: "namespace", name: "acode", tools: [{ type: "function", name: "read" }] }],
  });
  for (const field of [
    "max_output_tokens",
    "temperature",
    "prompt_cache_retention",
    "previous_response_id",
  ])
    expect(requests[0]).not.toHaveProperty(field);
  const input = requests[1]!.input as Record<string, unknown>[];
  expect(input[0]?.role).toBe("developer");
  const replay = input.find((item) => item.type === "function_call");
  expect(replay?.namespace).toBe("acode");
  expect(input.find((item) => item.type === "function_call_output")?.call_id).toBe(replay?.call_id);
});

test.each(["interrupted", "limit"])(
  "ChatGPT does not report a completed answer for %s streams",
  async (failure) => {
    const credentials = new PortableCredentialStore(null);
    await credentials.modify("chatgpt", async () => ({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Number.MAX_SAFE_INTEGER,
      scopes: ["chatgpt.tokens.use.direct"],
    }));
    const registry = new ProviderRegistry(credentials);
    const model = registry.models.getModels("chatgpt")[0]!;
    vi.stubGlobal("system", {
      httpStream: async () =>
        sse(
          failure === "limit"
            ? [
                {
                  type: "response.failed",
                  response: {
                    status: "failed",
                    error: {
                      code: "subscription_sharing_usage_limit_exceeded",
                      message: "Manage usage in ChatGPT",
                    },
                  },
                },
              ]
            : [{ type: "response.created", response: { id: "response" } }],
        ),
    });
    const result = await registry.models.completeSimple(model, {
      messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      failure === "limit" ? /subscription_sharing_usage_limit_exceeded/ : /terminal response/,
    );
  },
);

test("ChatGPT payload refuses unsupported hosted tool search", () => {
  expect(() => chatgptPayload({ input: [], tools: [{ type: "tool_search" }] })).toThrow(
    "not supported",
  );
});

test("account catalog refresh retains cached choices offline and admits newly discovered models", async () => {
  const credentials = new PortableCredentialStore(null);
  await credentials.modify("chatgpt", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Number.MAX_SAFE_INTEGER,
    clientId: "issued",
    scopes: ["chatgpt.tokens.use.direct"],
    availableModels: [{ id: "future-model", name: "Future model" }],
    availableModelsFetchedAt: Date.now(),
  }));
  const registry = new ProviderRegistry(credentials);
  expect((await registry.refreshModelAvailability("chatgpt"))[0]).toMatchObject({
    id: "future-model",
    api: "openai-responses",
    provider: "chatgpt",
  });
  vi.stubGlobal("system", {
    httpStream: async () => {
      throw new Error("Offline");
    },
  });
  expect((await registry.refreshModelAvailability("chatgpt", true))[0]?.id).toBe("future-model");
  vi.stubGlobal("system", { httpStream: async () => Response.json({ models: [] }) });
  expect(await registry.refreshModelAvailability("chatgpt", true)).toEqual([]);
});

test("an identity credential without plan permission cannot start inference", async () => {
  const credentials = new PortableCredentialStore(null);
  await credentials.modify("chatgpt", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Number.MAX_SAFE_INTEGER,
    scopes: ["openid"],
  }));
  const registry = new ProviderRegistry(credentials);
  const request = vi.fn();
  vi.stubGlobal("system", { httpStream: request });
  const result = await registry.models.completeSimple(registry.models.getModels("chatgpt")[0]!, {
    messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
  });
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("plan usage is not enabled");
  expect(request).not.toHaveBeenCalled();
});
