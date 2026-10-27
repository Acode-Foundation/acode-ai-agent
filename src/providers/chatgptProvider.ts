import type { Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  ChatGPTAccount,
  createChatGPTOAuth,
  CHATGPT_PROVIDER,
  CHATGPT_RESOURCE,
} from "./chatgptOAuth";

/** Adapt Pi's Responses transport to the ChatGPT-plan HTTP contract. */
export function chatgptPayload(value: unknown): Record<string, unknown> {
  const payload = { ...(value as Record<string, unknown>) };
  for (const field of [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "prompt_cache_options",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
  ])
    delete payload[field];
  payload.store = false;
  payload.stream = true;
  if (!Array.isArray(payload.input))
    throw new Error("ChatGPT requires a complete message history.");
  payload.input = payload.input.map((item: Record<string, unknown>) =>
    item.role === "system" ? { ...item, role: "developer" } : item,
  );
  if (Array.isArray(payload.tools)) {
    const tools = payload.tools as Record<string, unknown>[];
    if (
      tools.some(
        (tool) => !["function", "custom", "namespace", "web_search"].includes(String(tool.type)),
      )
    )
      throw new Error("This tool is not supported with ChatGPT plan usage.");
    const functions = tools.filter((tool) => tool.type === "function" || tool.type === "custom");
    payload.tools = [
      ...tools.filter((tool) => tool.type !== "function" && tool.type !== "custom"),
      ...(functions.length
        ? [
            {
              type: "namespace",
              name: "acode",
              description: "AcAgent tools",
              tools: functions,
            },
          ]
        : []),
    ];
    if (payload.tool_choice && typeof payload.tool_choice === "object") {
      const choice = payload.tool_choice as Record<string, unknown>;
      if (choice.type === "function" || choice.type === "custom")
        payload.tool_choice = { ...choice, namespace: "acode" };
    }
  }
  return payload;
}

export function createChatGPTProvider(accounts: ChatGPTAccount): Provider {
  const openai = openaiProvider();
  const adapt = (model: Model<any>): Model<any> => ({
    ...model,
    provider: CHATGPT_PROVIDER,
    api: "openai-responses",
    baseUrl: CHATGPT_RESOURCE,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      ...model.compat,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
      supportsMaxOutputTokens: false,
      supportsLongCacheRetention: false,
    },
  });
  const optionsFor = <T extends StreamOptions>(options?: T) => ({
    ...options,
    onPayload: async (payload: unknown, model: Model<any>) =>
      chatgptPayload((await options?.onPayload?.(payload, model)) ?? payload),
  });
  const withRequest = <T extends StreamOptions>(
    options: T | undefined,
    run: (options: T & { signal: AbortSignal }) => ReturnType<Provider["stream"]>,
  ) => {
    const request = accounts.request(options?.signal);
    try {
      const stream = run({ ...optionsFor(options), signal: request.signal } as T & {
        signal: AbortSignal;
      });
      void stream.result().then(request.release, request.release);
      return stream;
    } catch (error) {
      request.release();
      throw error;
    }
  };
  return {
    ...openai,
    id: CHATGPT_PROVIDER,
    name: "ChatGPT",
    baseUrl: CHATGPT_RESOURCE,
    auth: { oauth: createChatGPTOAuth(accounts) },
    getModels: () =>
      openai
        .getModels()
        .filter((model) => model.api === "openai-responses")
        .map(adapt),
    getAllModels: undefined,
    classify: undefined,
    filterAllModels: undefined,
    filterModels: (models, credential) =>
      credential?.type === "oauth" && Array.isArray(credential.availableModels)
        ? models.filter((model) =>
            (credential.availableModels as { id: string }[]).some((entry) => entry.id === model.id),
          )
        : [],
    stream: (model, context, options) =>
      withRequest(options, (options) => openai.stream(adapt(model), context, options)),
    streamSimple: (model, context, options) =>
      withRequest(options, (options) => openai.streamSimple(adapt(model), context, options)),
  };
}
