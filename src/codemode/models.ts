import type { Models, Usage } from "@earendil-works/pi-ai";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import type { CodemodeCallRecord } from "./createCodemodeTool";

/** `classify()` and `generateImages()` calls one script may have running; more wait their turn. */
const MAX_CONCURRENT_MODEL_CALLS = 4;
const ERROR_PREVIEW_CHARS = 300;

type ModelType = "chat" | "image" | "classifier";
const MODEL_TYPES = new Set<ModelType>(["chat", "image", "classifier"]);

const CLASSIFIER_CONTEXT_SHAPE =
  '{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: ' +
  '{ type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, ' +
  'criteria: [<lowest>, ..., <highest>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

export type ModelCallHooks = {
  /** A model call started; the returned function runs when it ends. */
  track(record: CodemodeCallRecord): () => void;
  /** Spend of a finished call, for the codemode result's usage. */
  addUsage(usage: Usage): void;
  /** Images a call returned, to notice a script that never shows or saves them. */
  addImages(count: number): void;
};

/**
 * `models.*` for scripts, after Pi's codemode: list the catalog, and run classifier and image
 * models with the chat's credentials. Calls are rows in the script's work-log card showing the
 * model only, never prompts or image data. Provider errors resolve with `stopReason` and
 * `errorMessage` instead of throwing; malformed arguments throw with the expected shape.
 */
export function createModelGlobals(models: Models, hooks: ModelCallHooks): CodemodeTool[] {
  const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);

  /** Resolve the model by provider and id only, so a script cannot send credentials elsewhere. */
  const runModelCall = async <TResult extends ModelResult>(
    name: string,
    type: "image" | "classifier",
    [given, context]: unknown[],
    check: (context: unknown) => unknown,
    run: (resolved: never, context: never) => Promise<TResult>,
  ): Promise<TResult> => {
    const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
    const model = typeof given === "string" ? modelByName(models, type, given) : given;
    if (typeof given === "string" && !model)
      throw new Error(`Unknown ${type} model "${given}". ${listHint}`);
    if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
      const missing =
        model === undefined || model === null
          ? " models.getModelOfType() returns undefined for an unknown provider or id."
          : "";
      throw new Error(
        `${name}() expects ${article(type)} model as its first argument, got ${describe(model)}.${missing} ${listHint}`,
      );
    }
    const resolved = models.getModelOfType(type, model.provider, model.id);
    if (!resolved) {
      const actual = [...MODEL_TYPES].find(
        (other) =>
          other !== type &&
          models.getModelOfType(other, model.provider as string, model.id as string),
      );
      throw new Error(
        actual
          ? `"${model.provider}/${model.id}" is ${article(actual)} model, not ${article(type)} model. ${listHint}`
          : `Unknown ${type} model "${model.provider}/${model.id}". ${listHint}`,
      );
    }
    const checked = check(context);
    const record: CodemodeCallRecord = {
      name,
      args: { model: `${resolved.provider}/${resolved.id}` },
      status: "running",
    };
    const done = hooks.track(record);
    const started = performance.now();
    try {
      const result = await limit(() => run(resolved as never, checked as never));
      record.status =
        result.stopReason === "stop"
          ? "ok"
          : result.stopReason === "aborted"
            ? "cancelled"
            : "error";
      if (result.errorMessage) record.error = preview(result.errorMessage);
      if (result.usage) hooks.addUsage(result.usage);
      return result;
    } catch (error) {
      record.status = "error";
      record.error = preview(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      record.durationMs = Math.round(performance.now() - started);
      done();
    }
  };

  const implementations: Record<
    string,
    (args: unknown[], context: { signal: AbortSignal }) => unknown
  > = {
    "models.getModelsOfType": ([type, provider]) =>
      models.getModelsOfType(modelType(type), providerId(provider)).map(modelInfo),
    "models.getAvailableOfType": async ([type, provider], { signal }) =>
      (await models.getAvailableOfType(modelType(type), providerId(provider), { signal })).map(
        modelInfo,
      ),
    "models.getModelOfType": (args) => {
      const [type, provider, id] = args;
      if (typeof provider !== "string" || typeof id !== "string")
        throw new Error(
          `models.getModelOfType(type, provider, id) expects three strings, got (${args.map(describe).join(", ")}). ` +
            'The provider and the id are separate, for example models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image").',
        );
      const model = models.getModelOfType(modelType(type), provider, id);
      return model === undefined ? undefined : modelInfo(model);
    },
    "models.classify": (args, { signal }) =>
      runModelCall(
        "models.classify",
        "classifier",
        args,
        checkClassifierContext,
        (model, context) => models.classify(model, context, { signal }),
      ),
    "models.generateImages": (args, { signal }) =>
      runModelCall(
        "models.generateImages",
        "image",
        args,
        checkImagesContext,
        async (model, context) => {
          const result = await models.generateImages(model, context, { signal });
          hooks.addImages(result.output.filter((block) => block.type === "image").length);
          return result;
        },
      ),
  };
  return Object.entries(implementations).map(([name, execute]) => ({
    name,
    spread: true,
    execute: (args, context) => execute(args as unknown[], context),
  }));
}

type ModelResult = { stopReason: string; errorMessage?: string; usage?: Usage };

/**
 * A model named by string, as models tend to write it: `"provider/id"` (`"openrouter/google/
 * gemini-2.5-flash-image"`) or just the id when one provider has it.
 */
function modelByName(models: Models, type: "image" | "classifier", name: string) {
  const slash = name.indexOf("/");
  if (slash > 0) {
    const named = models.getModelOfType(type, name.slice(0, slash), name.slice(slash + 1));
    if (named) return named;
  }
  const matches = models.getModelsOfType(type).filter((model) => model.id === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Sum spends into one, for the tool result. */
export function addUsage(total: Usage | undefined, usage: Usage): Usage {
  if (!total) return structuredClone(usage);
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

function checkClassifierContext(context: unknown): unknown {
  const fail = (problem: string) =>
    new Error(`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}.`);
  if (!isRecord(context))
    throw fail(`expects a context object as its second argument, got ${describe(context)}`);
  if (!isRecord(context.state))
    throw fail(`context.state must be an object, got ${describe(context.state)}`);
  const { images, questions } = context;
  if (images !== undefined) {
    if (!Array.isArray(images))
      throw fail(`context.images must be an array, got ${describe(images)}`);
    images.forEach((image, index) => {
      if (!isImageBlock(image))
        throw fail(`context.images[${index}] must be an image block, got ${describe(image)}`);
    });
  }
  if (!isRecord(questions) || !Object.keys(questions).length)
    throw fail(`context.questions must map question ids to questions, got ${describe(questions)}`);
  const strings = (values: unknown[]) =>
    values.length > 0 && values.every((value) => typeof value === "string");
  for (const [id, question] of Object.entries(questions)) {
    const at = `context.questions.${id}`;
    if (!isRecord(question))
      throw fail(`${at} must be a question object, got ${describe(question)}`);
    if (typeof question.instructions !== "string")
      throw fail(`${at}.instructions must be a string`);
    const { criteria } = question;
    if (question.type === "choice") {
      if (!isRecord(criteria) || !strings(Object.values(criteria)))
        throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
    } else if (question.type === "score") {
      if (!Array.isArray(criteria) || !strings(criteria))
        throw fail(`${at} is a "score" question, so criteria must list the levels, lowest first`);
    } else if (question.type === "bool") {
      if (
        !isRecord(criteria) ||
        typeof criteria.true !== "string" ||
        typeof criteria.false !== "string"
      )
        throw fail(
          `${at} is a "bool" question, so criteria must be { true: string, false: string }`,
        );
    } else {
      throw fail(
        `${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`,
      );
    }
  }
  return context;
}

function checkImagesContext(context: unknown): unknown {
  const fail = (problem: string) =>
    new Error(
      `models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ` +
        '...optional { type: "image", data: <base64>, mimeType } references] }.',
    );
  if (!isRecord(context))
    throw fail(`expects a context object as its second argument, got ${describe(context)}`);
  const { input } = context;
  if (!Array.isArray(input) || !input.length)
    throw fail(`context.input must be a non-empty array of blocks, got ${describe(input)}`);
  input.forEach((block, index) => {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
    if (isImageBlock(block)) return;
    throw fail(`context.input[${index}] must be a text or image block, got ${describe(block)}`);
  });
  return context;
}

/** Catalog entry for scripts, without `headers`, which can carry credentials. */
function modelInfo(model: object): Record<string, unknown> {
  const info = { ...(model as Record<string, unknown>) };
  delete info.headers;
  return info;
}

function modelType(value: unknown): ModelType {
  if (typeof value === "string" && MODEL_TYPES.has(value as ModelType)) return value as ModelType;
  throw new Error(
    `Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`,
  );
}

function providerId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("provider must be a string");
  return value;
}

/** Runs at most `max` calls at once, in call order. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function isImageBlock(
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A script value in an error message: `undefined`, `a string`, `an array`, or its keys. */
function describe(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (Array.isArray(value)) return value.length ? "an array" : "an empty array";
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
  }
  return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

function article(word: string): string {
  return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function preview(text: string): string {
  return text.length > ERROR_PREVIEW_CHARS ? `${text.slice(0, ERROR_PREVIEW_CHARS - 1)}…` : text;
}
