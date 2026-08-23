import {
	AgentHarness,
	AgentHarnessError,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	parseCommandArgs,
	shouldCompact,
	type AgentEvent,
	type AgentHarnessEvent,
	type AgentHarnessTool,
	type AgentMessage,
	type AgentTool,
	type Session,
	type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { Type, type ImageContent, type Model, type RetryPolicy } from "@earendil-works/pi-ai";
import { Signal } from "../core/events";
import type { ExtensionRegistry } from "../core/extensionRegistry";
import type { AgentSettings, QueuedPrompt, RestoredPrompt, SessionTreeItem, ToolActivity } from "../core/types";
import { resourceSlashCommands, type SlashCommand } from "../core/slashCommands";
import { toPiImages } from "../platform/promptImages";
import { buildSystemPrompt } from "../context/contextBuilder";
import { MutationGate } from "../permissions/mutationGate";
import type { ProviderRegistry } from "../providers/providerRegistry";
import type { SessionStore } from "../platform/sessionStore";
import { messageImages, messagePlainText, titleFromMessages } from "./sessionText";
import { createWorkspaceTools } from "../tools/createTools";
import { createTerminalBashTool } from "../tools/bash";
import { createWebSearchContext } from "../tools/web/context";
import { createWebTools } from "../tools/web/createWebTools";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { loadWorkspaceResources, type LoadedWorkspaceResources } from "./workspaceResources";

export type AgentSessionSnapshot = {
	messages: AgentMessage[];
	streamingMessage?: AgentMessage;
	activities: ToolActivity[];
	queued: QueuedPrompt[];
	isRunning: boolean;
	compacting: boolean;
	usage: { tokens: number; cost: number };
	contextTokens: number;
	commands: SlashCommand[];
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
	#store: SessionStore;
	#pi?: Session;
	#harness?: AgentHarness;
	#resources: LoadedWorkspaceResources = { skills: [], promptTemplates: [], skillRoots: [] };
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
		commands: resourceSlashCommands({}),
	};

	constructor(options: {
		id: string;
		title?: string;
		workspace: AcodeWorkspace;
		providers: ProviderRegistry;
		extensions: ExtensionRegistry;
		settings: () => AgentSettings;
		store: SessionStore;
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
			commands: [...this.#snapshot.commands],
		};
	}

	get model(): Model<any> | undefined {
		return this.#harness?.getModel();
	}

	async initialize(): Promise<void> {
		const settings = this.#settings();
		const opened = await this.#store.open({
			id: this.id,
			title: this.title,
			workspaceId: this.workspace.info.id,
			workspaceName: this.workspace.info.name,
			providerId: settings.providerId,
			modelId: settings.modelId,
		});
		this.title = opened.record.title;
		this.#pi = opened.session;
		this.#persistMeta = opened.update;
		this.#flushPersist = opened.persist;
		const storedModelId = opened.record.providerId === settings.providerId ? opened.record.modelId : settings.modelId;
		const model = this.#providers.resolveModel(settings.providerId, storedModelId || settings.modelId);
		const resources = await loadWorkspaceResources(this.workspace, settings.globalSkillRoots);
		this.#resources = resources;
		this.#harness = new AgentHarness({
			session: opened.session,
			models: this.#providers.models,
			model,
			thinkingLevel: settings.thinkingLevel,
			tools: toHarnessTools(this.#tools()),
			resources,
			retry: retryPolicy(settings),
			steeringMode: settings.steeringMode,
			followUpMode: settings.followUpMode,
			systemPrompt: () => this.#systemPrompt(),
			streamOptions: streamOptions(settings),
		});
		this.#unsubscribe = this.#harness.subscribe((event) => this.#onEvent(event));
		this.#harness.on("tool_call", async (event) => this.mutationGate.request(
			event.toolName,
			event.input,
			this.workspace,
			this.#settings().permissionMode,
			this.#runAbort.signal,
		));
		this.#snapshot = { ...this.#snapshot, commands: resourceSlashCommands(resources, settings) };
		await this.#refreshContext();
		this.#publish();
	}

	async refreshTools(): Promise<void> {
		if (!this.#harness) return;
		await this.#harness.setTools(toHarnessTools(this.#tools()));
	}

	async reloadResources(): Promise<{ skills: string[]; prompts: string[]; roots: string[] }> {
		const harness = this.#requireHarness();
		const settings = this.#settings();
		const resources = await loadWorkspaceResources(this.workspace, settings.globalSkillRoots);
		this.#resources = resources;
		await harness.setResources(resources);
		this.#snapshot = { ...this.#snapshot, commands: resourceSlashCommands(resources, settings), error: undefined };
		this.#publish();
		return {
			skills: (resources.skills ?? []).map((skill) => skill.name),
			prompts: (resources.promptTemplates ?? []).map((prompt) => prompt.name),
			roots: resources.skillRoots,
		};
	}

	async applySettings(settings: AgentSettings): Promise<void> {
		const harness = this.#harness;
		if (!harness) return;
		await Promise.all([
			harness.setSteeringMode(settings.steeringMode),
			harness.setFollowUpMode(settings.followUpMode),
			harness.setStreamOptions(streamOptions(settings)),
		]);
		this.#snapshot = { ...this.#snapshot, commands: resourceSlashCommands(this.#resources, settings) };
		this.#publish();
	}

	async invokeResource(commandName: string, args: string): Promise<void> {
		const harness = this.#requireHarness();
		if (this.#running || this.#compacting) throw new Error("Wait for the current run to finish before starting a command.");
		const resources = harness.getResources();
		this.#runAbort = new AbortController();
		this.#snapshot = { ...this.#snapshot, error: undefined };
		if (commandName.startsWith("skill:")) {
			const name = commandName.slice("skill:".length);
			if (!(resources.skills ?? []).some((skill) => skill.name.toLowerCase() === name.toLowerCase())) {
				throw new Error(`Unknown skill command: /${commandName}`);
			}
			await harness.skill(name, args || undefined);
			return;
		}
		const template = (resources.promptTemplates ?? []).find((item) => item.name.toLowerCase() === commandName.toLowerCase());
		if (!template) throw new Error(`Unknown command: /${commandName}`);
		await harness.promptFromTemplate(template.name, parseCommandArgs(args));
	}

	async compact(customInstructions?: string): Promise<void> {
		if (this.#running || this.#compacting) throw new Error("Wait for the current run to finish before compacting.");
		const harness = this.#requireHarness();
		this.#compacting = true;
		this.#publish();
		try {
			await harness.compact(customInstructions?.trim() || undefined);
			await this.#refreshContext();
			await this.persist();
		} finally {
			this.#compacting = false;
			this.#publish();
		}
	}

	async rename(name: string): Promise<void> {
		const next = name.replace(/[\r\n]+/g, " ").trim();
		if (!next) throw new Error("Add a name after /name.");
		if (!this.#pi) throw new Error("Agent session has not been initialized.");
		await this.#pi.appendSessionName(next);
		this.title = next;
		this.#persistMeta?.({ title: next });
		await this.#flushPersist?.();
		this.#publish();
	}

	latestAssistantText(): string {
		for (let index = this.#messages.length - 1; index >= 0; index -= 1) {
			const message = this.#messages[index];
			if (message?.role === "assistant") return messagePlainText(message);
		}
		return "";
	}

	sessionInfo(): { id: string; title: string; tokens: number; cost: number } {
		return { id: this.id, title: this.title, tokens: this.#snapshot.usage.tokens, cost: this.#snapshot.usage.cost };
	}

	async treeItems(): Promise<SessionTreeItem[]> {
		if (!this.#pi) return [];
		const [entries, leafId] = await Promise.all([this.#pi.getEntries(), this.#pi.getLeafId()]);
		return buildTreeItems(entries, leafId);
	}

	async navigateTree(targetId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<string | undefined> {
		if (this.#running || this.#compacting) throw new Error("Wait for the current run to finish before navigating the tree.");
		const result = await this.#requireHarness().navigateTree(targetId, options);
		await this.#refreshContext();
		await this.persist();
		this.#publish();
		return result.cancelled ? undefined : result.editorText;
	}

	async branchEntries(targetId?: string): Promise<SessionTreeEntry[]> {
		if (!this.#pi) return [];
		return this.#pi.getBranch(targetId);
	}

	async exportJson(): Promise<string> {
		if (!this.#pi) throw new Error("Agent session has not been initialized.");
		const [entries, metadata] = await Promise.all([this.#pi.getEntries(), this.#pi.getMetadata()]);
		return JSON.stringify({ version: 1, metadata, name: this.title, workspace: this.workspace.info, entries }, null, 2);
	}

	async prompt(text: string, mode: "steer" | "followUp" = "steer", images?: ImageContent[]): Promise<void> {
		const harness = this.#requireHarness();
		if (this.#compactPromise) await this.#compactPromise;
		const options = promptImages(images);
		try {
			if (mode === "followUp") {
				await harness.followUp(text, options);
				return;
			}
			await harness.steer(text, options);
		} catch (error) {
			if (!(error instanceof AgentHarnessError) || error.code !== "invalid_state") throw error;
			this.#runAbort = new AbortController();
			this.#beginRun();
			this.#snapshot = { ...this.#snapshot, error: undefined };
			this.#publish();
			try {
				await this.#compactIfNeeded();
				await harness.prompt(text, options);
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

	async abort(): Promise<RestoredPrompt[]> {
		const harness = this.#harness;
		this.#runAbort.abort();
		this.#running = false;
		this.#queued = [];
		this.#settleActivities();
		this.#publish();
		if (!harness) return [];
		try {
			const result = await harness.abort();
			const restored = [...result.clearedSteer, ...result.clearedFollowUp].map(restorePrompt).filter((item) => item.text || item.images.length);
			await this.#refreshContext();
			this.#publish();
			return restored;
		} catch (error) {
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
		this.title = await this.#pi.getSessionName() || titleFromMessages(this.#messages);
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
				...event.steer.map((message) => queuedFromMessage(message, "steer")),
				...event.followUp.map((message) => queuedFromMessage(message, "followUp")),
			].filter((item) => item.text.trim() || item.images);
		}
		if (event.type === "agent_start") this.#beginRun();
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
			if (event.message.role === "user") this.#rememberUserMessage(event.message);
		}
		if (event.type === "message_end") {
			this.#streaming = undefined;
			if (event.message.role === "assistant" && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) {
				this.#snapshot = {
					...this.#snapshot,
					error: event.message.errorMessage?.trim() || (event.message.stopReason === "aborted" ? "The model request was cancelled." : "The model request failed."),
				};
			}
		}
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
		const settings = this.#settings();
		if (!settings.autoCompaction) return;
		await this.#refreshContext();
		const model = harness.getModel();
		if (!shouldCompact(this.#snapshot.contextTokens, model.contextWindow, {
			...DEFAULT_COMPACTION_SETTINGS,
			enabled: settings.autoCompaction,
			reserveTokens: settings.compactionReserveTokens,
			keepRecentTokens: settings.compactionKeepRecentTokens,
		})) return;
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
			commands: this.#snapshot.commands,
		};
	}

	#beginRun(): void {
		this.#running = true;
		this.#activities.clear();
		this.#streaming = undefined;
		this.#snapshot = { ...this.#snapshot, error: undefined };
	}

	#rememberUserMessage(message: AgentMessage): void {
		if (message.role !== "user") return;
		const exists = this.#messages.some((item) => item.role === "user" && "timestamp" in item && item.timestamp === message.timestamp);
		if (!exists) this.#messages = [...this.#messages, message];
	}

	#settleActivities(): void {
		this.#activities.clear();
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
			commands: this.#snapshot.commands,
			error: overrides?.error ?? this.#snapshot.error,
		};
		this.changes.emit(this.snapshot);
	}

	#tools(): AgentTool[] {
		const bash = createTerminalBashTool(this.workspace);
		return [
			...createWorkspaceTools(this.workspace, { maxWalkFiles: () => this.#settings().maxWalkFiles }),
			...(bash ? [bash] : []),
			this.#skillTool(),
			...createWebTools(createWebSearchContext({
				models: this.#providers.models,
				settings: this.#settings,
			})),
			...this.#extensions.tools,
		];
	}

	#skillTool(): AgentTool<any> {
		return {
			name: "load_skill",
			label: "Load skill",
			description: "Load an already-discovered project or global skill, or one of its relative reference files. Do not search the workspace for SKILL.md first; global skills are outside the workspace sandbox.",
			parameters: Type.Object({
				name: Type.String({ description: "Skill name from available_skills" }),
				path: Type.Optional(Type.String({ description: "Optional file path relative to the skill folder, such as references/api.md" })),
			}),
			executionMode: "parallel",
			execute: async (_id, params) => {
				const input = params as { name?: string; path?: string };
				const name = String(input.name ?? "");
				const skill = (this.#resources.skills ?? []).find((item) => item.name.toLowerCase() === name.toLowerCase());
				if (!skill) throw new Error(`Unknown skill: ${name}`);
				const relativePath = normalizeSkillPath(input.path);
				const text = relativePath ? await readSkillRelativeFile(this.workspace, skill.filePath, relativePath) : skill.content;
				return {
					content: [{ type: "text", text: `<skill name="${skill.name}" location="${skill.filePath}"${relativePath ? ` file="${relativePath}"` : ""}>\n${text}\n</skill>` }],
					details: { name: skill.name, path: relativePath || skill.filePath },
				};
			},
		};
	}

	async #systemPrompt(): Promise<string> {
		try {
			const prompt = await buildSystemPrompt(this.workspace, this.#settings(), this.#extensions);
			const skills = this.#harness?.getResources().skills ?? [];
			const skillBlock = formatAcodeSkills(skills.filter((skill) => !skill.disableModelInvocation));
			return skillBlock ? `${prompt}\n\n${skillBlock}` : prompt;
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

function promptImages(images?: ImageContent[]): { images: ImageContent[] } | undefined {
	const next = toPiImages(images ?? []);
	return next.length ? { images: next } : undefined;
}

function restorePrompt(message: AgentMessage): RestoredPrompt {
	return { text: messagePlainText(message), images: messageImages(message) };
}

function queuedFromMessage(message: AgentMessage, mode: QueuedPrompt["mode"]): QueuedPrompt {
	const images = messageImages(message).length;
	return { text: messagePlainText(message), mode, images: images || undefined };
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

function retryPolicy(settings: AgentSettings): RetryPolicy {
	return {
		enabled: settings.retryEnabled,
		maxRetries: settings.retryMaxRetries,
		baseDelayMs: settings.retryBaseDelayMs,
	};
}

function streamOptions(settings: AgentSettings) {
	return {
		transport: settings.transport,
		timeoutMs: settings.providerTimeoutMs,
		maxRetries: settings.providerMaxRetries,
		maxRetryDelayMs: settings.providerMaxRetryDelayMs,
	};
}

function buildTreeItems(entries: SessionTreeEntry[], leafId: string | null): SessionTreeItem[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type === "label") {
			if (entry.label) labels.set(entry.targetId, entry.label);
			else labels.delete(entry.targetId);
		}
	}
	const activeIds = new Set<string>();
	let cursor = leafId;
	while (cursor) {
		activeIds.add(cursor);
		cursor = byId.get(cursor)?.parentId ?? null;
	}
	const displayEntries = entries.filter((entry) => !["label", "leaf", "session_info"].includes(entry.type));
	const displayIds = new Set(displayEntries.map((entry) => entry.id));
	const displayAncestor = (id: string | null): string | null => {
		let next = id;
		while (next && !displayIds.has(next)) next = byId.get(next)?.parentId ?? null;
		return next;
	};
	const currentId = displayAncestor(leafId);
	return displayEntries.map((entry) => {
		const described = describeTreeEntry(entry);
		return {
			id: entry.id,
			parentId: displayAncestor(entry.parentId),
			type: entry.type,
			kind: described.kind,
			text: described.text,
			timestamp: entry.timestamp,
			active: activeIds.has(entry.id),
			current: entry.id === currentId,
			label: labels.get(entry.id),
		};
	});
}

function describeTreeEntry(entry: SessionTreeEntry): Pick<SessionTreeItem, "kind" | "text"> {
	if (entry.type === "message") {
		const role = entry.message.role;
		return {
			kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "tool",
			text: agentMessageText(entry.message) || (role === "assistant" ? "Assistant response" : role === "user" ? "User prompt" : "Tool result"),
		};
	}
	if (entry.type === "compaction") return { kind: "summary", text: `Compaction · ${entry.summary}` };
	if (entry.type === "branch_summary") return { kind: "summary", text: `Branch summary · ${entry.summary}` };
	if (entry.type === "model_change") return { kind: "state", text: `Model · ${entry.provider}/${entry.modelId}` };
	if (entry.type === "thinking_level_change") return { kind: "state", text: `Thinking · ${entry.thinkingLevel}` };
	if (entry.type === "active_tools_change") return { kind: "state", text: `Tools · ${entry.activeToolNames.join(", ") || "none"}` };
	if (entry.type === "custom_message") {
		const text = typeof entry.content === "string" ? entry.content : entry.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
		return { kind: "state", text: text || entry.customType };
	}
	if (entry.type === "custom") return { kind: "state", text: `Custom · ${entry.customType}` };
	return { kind: "state", text: entry.type.replace(/_/g, " ") };
}

function agentMessageText(message: AgentMessage): string {
	if (!("content" in message)) return messagePlainText(message).replace(/\s+/g, " ").trim();
	const content = message.content;
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (Array.isArray(content)) {
		return content.flatMap((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? [String(part.text)] : []).join(" ").replace(/\s+/g, " ").trim();
	}
	return messagePlainText(message).replace(/\s+/g, " ").trim();
}

function formatAcodeSkills(skills: NonNullable<LoadedWorkspaceResources["skills"]>): string {
	if (!skills.length) return "";
	const rows = skills.map((skill) => [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		"  </skill>",
	].join("\n"));
	return [
		"The skills below have already been discovered from project and configured global Pi skill roots.",
		"Treat this catalog as the source of truth for skill access. Do not list .agents/.pi or search for SKILL.md to check access; global skills are intentionally outside workspace file tools.",
		"When a task matches, call load_skill directly with its listed name. Use load_skill's optional path for referenced files.",
		"<available_skills>",
		...rows,
		"</available_skills>",
	].join("\n");
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function normalizeSkillPath(value: string | undefined): string {
	const path = value?.trim().replace(/\\/g, "/").replace(/^\.\//, "") ?? "";
	if (!path) return "";
	if (path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) {
		throw new Error("Skill reference paths must stay inside the skill folder.");
	}
	return path.replace(/\/+/g, "/");
}

async function readSkillRelativeFile(workspace: AcodeWorkspace, skillFilePath: string, relativePath: string): Promise<string> {
	const slash = skillFilePath.lastIndexOf("/");
	const base = slash >= 0 ? skillFilePath.slice(0, slash) : "";
	if (skillFilePath.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(skillFilePath)) {
		return acode.fsOperation(acode.joinUrl(base, relativePath)).readFile("utf-8");
	}
	return workspace.readText([base, relativePath].filter(Boolean).join("/"));
}
