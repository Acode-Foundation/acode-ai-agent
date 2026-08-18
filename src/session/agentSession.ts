import {
	AgentHarness,
	AgentHarnessError,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	shouldCompact,
	type AgentEvent,
	type AgentHarnessEvent,
	type AgentHarnessTool,
	type AgentMessage,
	type AgentTool,
	type Session,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Signal } from "../core/events";
import type { ExtensionRegistry } from "../core/extensionRegistry";
import type { AgentSettings, QueuedPrompt, ToolActivity } from "../core/types";
import { buildSystemPrompt } from "../context/contextBuilder";
import { MutationGate } from "../permissions/mutationGate";
import type { ProviderRegistry } from "../providers/providerRegistry";
import { BrowserSessionStore, messagePlainText, titleFromMessages } from "../platform/browserStorage";
import { createWorkspaceTools } from "../tools/createTools";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";

export type AgentSessionSnapshot = {
	messages: AgentMessage[];
	streamingMessage?: AgentMessage;
	activities: ToolActivity[];
	queued: QueuedPrompt[];
	isRunning: boolean;
	compacting: boolean;
	usage: { tokens: number; cost: number };
	contextTokens: number;
	error?: string;
};

export class AgentSession {
	readonly id: string;
	title: string;
	readonly changes = new Signal<AgentSessionSnapshot>();
	readonly mutationGate: MutationGate;
	readonly workspace: AcodeWorkspace;
	#providers: ProviderRegistry;
	#extensions: ExtensionRegistry;
	#settings: () => AgentSettings;
	#store: BrowserSessionStore;
	#pi?: Session;
	#harness?: AgentHarness;
	#unsubscribe?: () => void;
	#persistMeta?: (patch: { title?: string; providerId?: string; modelId?: string }) => void;
	#flushPersist?: () => Promise<void>;
	#activities = new Map<string, ToolActivity>();
	#messages: AgentMessage[] = [];
	#streaming?: AgentMessage;
	#queued: QueuedPrompt[] = [];
	#runAbort = new AbortController();
	#running = false;
	#compacting = false;
	#compactPromise?: Promise<void>;
	#snapshot: AgentSessionSnapshot = {
		messages: [],
		activities: [],
		queued: [],
		isRunning: false,
		compacting: false,
		usage: { tokens: 0, cost: 0 },
		contextTokens: 0,
	};

	constructor(options: {
		id: string;
		title?: string;
		workspace: AcodeWorkspace;
		providers: ProviderRegistry;
		extensions: ExtensionRegistry;
		settings: () => AgentSettings;
		store: BrowserSessionStore;
		mutationGate: MutationGate;
	}) {
		this.id = options.id;
		this.title = options.title ?? "New chat";
		this.workspace = options.workspace;
		this.#providers = options.providers;
		this.#extensions = options.extensions;
		this.#settings = options.settings;
		this.#store = options.store;
		this.mutationGate = options.mutationGate;
	}

	get snapshot(): AgentSessionSnapshot {
		return {
			...this.#snapshot,
			messages: [...this.#snapshot.messages],
			activities: [...this.#snapshot.activities],
			queued: [...this.#snapshot.queued],
		};
	}

	get model(): Model<any> | undefined {
		return this.#harness?.getModel();
	}

	async initialize(): Promise<void> {
		const settings = this.#settings();
		const opened = this.#store.open({
			id: this.id,
			title: this.title,
			workspaceId: this.workspace.info.id,
			providerId: settings.providerId,
			modelId: settings.modelId,
		});
		this.title = opened.record.title;
		this.#pi = opened.session;
		this.#persistMeta = opened.update;
		this.#flushPersist = opened.persist;
		const storedModelId = opened.record.providerId === settings.providerId ? opened.record.modelId : settings.modelId;
		const model = this.#providers.resolveModel(settings.providerId, storedModelId || settings.modelId);
		this.#harness = new AgentHarness({
			session: opened.session,
			models: this.#providers.models,
			model,
			thinkingLevel: settings.thinkingLevel,
			tools: toHarnessTools(this.#tools()),
			systemPrompt: () => this.#systemPrompt(),
			streamOptions: { transport: "sse" },
		});
		this.#unsubscribe = this.#harness.subscribe((event) => this.#onEvent(event));
		this.#harness.on("tool_call", async (event) => this.mutationGate.request(
			event.toolName,
			event.input,
			this.workspace,
			this.#settings().permissionMode,
			this.#runAbort.signal,
		));
		await this.#refreshContext();
		this.#publish();
	}

	async refreshTools(): Promise<void> {
		if (!this.#harness) return;
		await this.#harness.setTools(toHarnessTools(this.#tools()));
	}

	async prompt(text: string, mode: "steer" | "followUp" = "steer"): Promise<void> {
		const harness = this.#requireHarness();
		if (this.#compactPromise) await this.#compactPromise;
		try {
			if (mode === "followUp") {
				await harness.followUp(text);
				return;
			}
			await harness.steer(text);
		} catch (error) {
			if (!(error instanceof AgentHarnessError) || error.code !== "invalid_state") throw error;
			this.#runAbort = new AbortController();
			this.#running = true;
			this.#snapshot = { ...this.#snapshot, error: undefined };
			this.#publish();
			try {
				await this.#compactIfNeeded();
				await harness.prompt(text);
				await this.#compactIfNeeded();
			} finally {
				this.#running = false;
				this.#settleActivities();
				await this.#refreshContext();
				await this.persist();
				this.#publish();
			}
		}
	}

	async abort(): Promise<string[]> {
		const harness = this.#harness;
		this.#runAbort.abort();
		if (!harness) {
			this.#running = false;
			this.#publish();
			return [];
		}
		try {
			const result = await harness.abort();
			const restored = [...result.clearedSteer, ...result.clearedFollowUp].map(messagePlainText).filter(Boolean);
			this.#queued = [];
			this.#running = false;
			this.#settleActivities();
			await this.#refreshContext();
			this.#publish();
			return restored;
		} catch (error) {
			this.#running = false;
			this.#queued = [];
			this.#publish({ error: error instanceof Error ? error.message : String(error) });
			return [];
		}
	}

	async setModel(model: Model<any>): Promise<void> {
		if (!this.#harness) return;
		await this.#harness.setModel(model);
		this.#persistMeta?.({ providerId: model.provider, modelId: model.id });
		this.#publish();
	}

	async setThinkingLevel(level: AgentSettings["thinkingLevel"]): Promise<void> {
		if (!this.#harness) return;
		await this.#harness.setThinkingLevel(level);
	}

	async persist(): Promise<void> {
		if (!this.#pi) return;
		this.title = titleFromMessages(this.#messages);
		this.#persistMeta?.({
			title: this.title,
			providerId: this.#harness?.getModel().provider,
			modelId: this.#harness?.getModel().id,
		});
		await this.#flushPersist?.();
	}

	async dispose(): Promise<void> {
		this.#runAbort.abort();
		await this.#harness?.abort().catch(() => undefined);
		await this.#harness?.waitForIdle().catch(() => undefined);
		await this.persist().catch(() => undefined);
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.mutationGate.dispose();
		this.changes.clear();
		this.#harness = undefined;
		this.#pi = undefined;
	}

	async #onEvent(event: AgentHarnessEvent): Promise<void> {
		if (isAgentEvent(event)) this.#onAgentEvent(event);
		if (event.type === "queue_update") {
			this.#queued = [
				...event.steer.map((message) => ({ text: messagePlainText(message), mode: "steer" as const })),
				...event.followUp.map((message) => ({ text: messagePlainText(message), mode: "followUp" as const })),
			].filter((item) => item.text.trim());
		}
		if (event.type === "agent_start") this.#running = true;
		if (event.type === "settled" || event.type === "abort") {
			this.#running = false;
			this.#settleActivities();
			if (event.type === "abort") this.#queued = [];
			await this.#refreshContext();
			await this.persist();
		}
		if (event.type === "session_compact") {
			await this.#refreshContext();
			await this.persist();
		}
		if (event.type === "message_end") await this.#refreshContext();
		this.#publish();
	}

	#onAgentEvent(event: AgentEvent): void {
		if (event.type === "message_start" || event.type === "message_update") {
			if (event.message.role === "assistant") this.#streaming = event.message;
		}
		if (event.type === "message_end") this.#streaming = undefined;
		if (event.type === "tool_execution_start") {
			this.#activities.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: sanitizeArgs(event.args),
				status: "running",
				startedAt: Date.now(),
			});
		}
		if (event.type === "tool_execution_update") {
			const activity = this.#activities.get(event.toolCallId);
			if (activity) activity.summary = toolResultText(event.partialResult);
		}
		if (event.type === "tool_execution_end") {
			const activity = this.#activities.get(event.toolCallId);
			if (activity) {
				activity.status = event.isError ? "error" : "done";
				activity.summary = toolResultText(event.result);
				activity.endedAt = Date.now();
				if (event.isError) activity.error = activity.summary;
			}
		}
	}

	async #compactIfNeeded(): Promise<void> {
		if (this.#compactPromise) return this.#compactPromise;
		const harness = this.#harness;
		if (!harness) return;
		await this.#refreshContext();
		const model = harness.getModel();
		if (!shouldCompact(this.#snapshot.contextTokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
		this.#compacting = true;
		this.#publish();
		this.#compactPromise = (async () => {
			try {
				await harness.compact();
				await this.#refreshContext();
			} catch (error) {
				console.warn("AI auto-compaction failed", error);
			} finally {
				this.#compacting = false;
				this.#compactPromise = undefined;
				this.#publish();
			}
		})();
		await this.#compactPromise;
	}

	async #refreshContext(): Promise<void> {
		if (!this.#pi) return;
		const [context, stats] = await Promise.all([this.#pi.buildContext(), this.#pi.getSessionStats()]);
		this.#messages = context.messages;
		this.#snapshot = {
			...this.#snapshot,
			usage: { tokens: stats.totalTokens, cost: stats.costTotal },
			contextTokens: estimateContextTokens(context.messages).tokens,
		};
	}

	#settleActivities(): void {
		for (const activity of this.#activities.values()) {
			if (activity.status === "running") activity.status = "done";
		}
		this.#streaming = undefined;
	}

	#publish(overrides?: Partial<Pick<AgentSessionSnapshot, "error">>): void {
		this.#snapshot = {
			messages: this.#messages,
			streamingMessage: this.#running ? this.#streaming : undefined,
			activities: [...this.#activities.values()].slice(-20),
			queued: [...this.#queued],
			isRunning: this.#running || this.#compacting,
			compacting: this.#compacting,
			usage: this.#snapshot.usage,
			contextTokens: this.#snapshot.contextTokens,
			error: overrides?.error ?? this.#snapshot.error,
		};
		this.changes.emit(this.snapshot);
	}

	#tools(): AgentTool[] {
		return [
			...createWorkspaceTools(this.workspace, { maxWalkFiles: () => this.#settings().maxWalkFiles }),
			...this.#extensions.tools,
		];
	}

	async #systemPrompt(): Promise<string> {
		try {
			return await buildSystemPrompt(this.workspace, this.#settings(), this.#extensions);
		} catch (error) {
			console.warn("AI system prompt context failed", error);
			return [
				"You are Acode's in-editor coding agent, powered by the Pi agent runtime.",
				"Work autonomously toward the user's requested outcome and use tools to inspect evidence before guessing.",
				"Every tool path is POSIX-style and relative to the active workspace.",
				`Workspace: ${this.workspace.info.name}.`,
			].join("\n\n");
		}
	}

	#requireHarness(): AgentHarness {
		if (!this.#harness) throw new Error("Agent session has not been initialized.");
		return this.#harness;
	}
}

function toHarnessTools(tools: AgentTool[]): AgentHarnessTool<undefined>[] {
	return tools.map((tool) => ({
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	}));
}

function isAgentEvent(event: AgentHarnessEvent): event is AgentEvent {
	return event.type === "agent_start"
		|| event.type === "agent_end"
		|| event.type === "turn_start"
		|| event.type === "turn_end"
		|| event.type === "message_start"
		|| event.type === "message_update"
		|| event.type === "message_end"
		|| event.type === "tool_execution_start"
		|| event.type === "tool_execution_update"
		|| event.type === "tool_execution_end";
}

function sanitizeArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return {};
	const value = { ...(args as Record<string, unknown>) };
	if ("content" in value) value.content = `[${String(value.content).length} characters]`;
	if ("new_string" in value) value.new_string = `[${String(value.new_string).length} characters]`;
	if ("old_string" in value) value.old_string = `[${String(value.old_string).length} characters]`;
	return value;
}

function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	return content?.find((item) => item.type === "text")?.text?.slice(0, 300) ?? "";
}
