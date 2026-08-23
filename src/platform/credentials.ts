import type {
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";

const SECRET_PREFIX = "provider:";

export class PortableCredentialStore implements CredentialStore {
	#ctx: Acode.PluginContext | null;
	#memory = new Map<string, Credential>();
	#chains = new Map<string, Promise<unknown>>();

	constructor(ctx: Acode.PluginContext | null) {
		this.#ctx = ctx;
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
			"openrouter", "openai", "openai-codex", "anthropic", "github-copilot", "google", "xai", "groq",
			"deepseek", "cerebras", "fireworks", "together", "moonshotai", "minimax", "zai", "kimi-coding",
			"qwen-token-plan", "ant-ling", "xiaomi",
		];
		const credentials = await Promise.all(providerIds.map(async (providerId) => ({
			providerId,
			credential: await this.read(providerId),
		})));
		return credentials
			.filter((entry): entry is { providerId: string; credential: Credential } => Boolean(entry.credential))
			.map(({ providerId, credential }) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, async () => {
			const current = await this.read(providerId);
			const next = await fn(current);
			if (next === undefined) return current;
			await this.#write(providerId, next);
			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#enqueue(providerId, async () => {
			this.#memory.delete(providerId);
				if (this.#ctx) await this.#ctx.setSecret(`${SECRET_PREFIX}${providerId}`, "");
			});
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
	}

	#enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const run = previous.then(task, task);
		this.#chains.set(providerId, run.catch(() => undefined));
		return run;
	}
}
