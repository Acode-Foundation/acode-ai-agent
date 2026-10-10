import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

import { Signal } from "../core/events";

export type PendingSignIn = { state: string; verifier: string; expiresAt: number };

const SECRET_PREFIX = "provider:";

export class PortableCredentialStore implements CredentialStore {
  readonly changes = new Signal<string>();
  #ctx: Acode.PluginContext | null;
  #memory = new Map<string, Credential>();
  #chains = new Map<string, Promise<unknown>>();
  #extraIds: () => readonly string[];
  #pending = new Map<string, PendingSignIn>();

  constructor(ctx: Acode.PluginContext | null, extraIds: () => readonly string[] = () => []) {
    this.#ctx = ctx;
    this.#extraIds = extraIds;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (!this.#ctx) return this.#memory.get(providerId);
    const value = await this.#ctx.getSecret(`${SECRET_PREFIX}${providerId}`, "");
    if (!value) return undefined;
    try {
      return JSON.parse(value) as Credential;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const providerIds = [
      ...new Set([
        "openrouter",
        "openai",
        "openai-codex",
        "anthropic",
        "github-copilot",
        "google",
        "xai",
        "groq",
        "deepseek",
        "cerebras",
        "fireworks",
        "together",
        "moonshotai",
        "minimax",
        "zai",
        "kimi-coding",
        "qwen-token-plan",
        "ant-ling",
        "xiaomi",
        ...this.#extraIds(),
      ]),
    ];
    const credentials = await Promise.all(
      providerIds.map(async (providerId) => ({
        providerId,
        credential: await this.read(providerId),
      })),
    );
    return credentials
      .filter((entry): entry is { providerId: string; credential: Credential } =>
        Boolean(entry.credential),
      )
      .map(({ providerId, credential }) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const signal = options?.signal;
    return this.#enqueue(
      providerId,
      async () => {
        const current = await this.read(providerId);
        signal?.throwIfAborted();
        // Once fn starts, finish persistence: a refresh may already have rotated tokens.
        const next = await fn(current);
        if (next === undefined) return current;
        await this.#write(providerId, next);
        return next;
      },
      signal,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#enqueue(
      providerId,
      async () => {
        this.#memory.delete(providerId);
        if (this.#ctx) await this.#ctx.setSecret(`${SECRET_PREFIX}${providerId}`, "");
        this.changes.emit(providerId);
      },
      options?.signal,
    );
  }

  pendingSignIn(providerId: string): Promise<PendingSignIn | undefined> {
    return this.#enqueue(`pending:${providerId}`, () => this.#readPending(providerId));
  }

  savePendingSignIn(providerId: string, pending: PendingSignIn): Promise<void> {
    return this.#enqueue(`pending:${providerId}`, async () => {
      if (this.#ctx)
        await this.#ctx.setSecret(`oauth-pending:${providerId}`, JSON.stringify(pending));
      this.#pending.set(providerId, pending);
    });
  }

  clearPendingSignIn(providerId: string, state?: string): Promise<void> {
    return this.#enqueue(`pending:${providerId}`, async () => {
      if (state && (await this.#readPending(providerId))?.state !== state) return;
      if (this.#ctx) await this.#ctx.setSecret(`oauth-pending:${providerId}`, "");
      this.#pending.delete(providerId);
    });
  }

  async #readPending(providerId: string): Promise<PendingSignIn | undefined> {
    if (!this.#ctx) return this.#pending.get(providerId);
    const raw = await this.#ctx.getSecret(`oauth-pending:${providerId}`, "");
    try {
      const value = JSON.parse(raw) as PendingSignIn;
      if (
        /^[A-Za-z0-9_-]{43}$/.test(value.state) &&
        /^[A-Za-z0-9_-]{43}$/.test(value.verifier) &&
        Number.isFinite(value.expiresAt)
      )
        return value;
    } catch {}
    return undefined;
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      await this.delete(providerId);
      return;
    }
    await this.modify(providerId, async () => ({ type: "api_key", key: trimmed }));
  }

  async #write(providerId: string, credential: Credential): Promise<void> {
    this.#memory.set(providerId, credential);
    if (this.#ctx) {
      await this.#ctx.setSecret(`${SECRET_PREFIX}${providerId}`, JSON.stringify(credential));
    }
    this.changes.emit(providerId);
  }

  #enqueue<T>(providerId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    let onAbort: (() => void) | undefined;
    const start = () => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      signal?.throwIfAborted();
      return task();
    };
    const run = previous.then(start, start);
    // Caller cancellation must not release the serialized queue.
    this.#chains.set(
      providerId,
      run.catch(() => undefined),
    );
    if (!signal) return run;
    return new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void run.then(resolve, reject);
    });
  }
}
