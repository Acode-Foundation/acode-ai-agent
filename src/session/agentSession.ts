import {
	AgentHarness,
	BACKGROUND_CONTEXT as context,
	getOrThrow,
	createCompactionSummaryMessage,
	createBranchSummaryMessage,
	type AgentLane,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	parseCommandArgs,

	type HarnessEvent,
	type AgentHarnessTool,
	type AgentMessage,
	type AgentTool,
	type Session,
	type Entry,
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
import { createAskTool } from "../ask/createAskTool";
import { QuestionGate } from "../ask/questionGate";
import { createTaskTools } from "../tasks/createTaskTools";
import {
	buildTaskReminder,
	createCadenceState,
	drainReminder,
	evaluateReminder,
	markStaleInProgress,
	noteResolvedBoundary,
	onTurnStart,
	resetCadenceState,
	shouldAutoClear,
} from "../tasks/reminder";
import { parseTaskStore, TaskList } from "../tasks/taskList";
import type { Task, TaskStatus } from "../tasks/types";
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
	tasks: Task[];
	error?: string;
};

export class AgentSession {
	readonly id: string;
	title: string;
	readonly changes = new Signal<AgentSessionSnapshot>();
	readonly mutationGate: MutationGate;
	readonly questionGate = new QuestionGate();
	readonly workspace: AcodeWorkspace;
	#providers: ProviderRegistry;
	#extensions: ExtensionRegistry;
	#settings: () => AgentSettings;
	#store: SessionStore;
	#pi?: Session;
	#harness?: AgentHarness<undefined>;
	#lane?: AgentLane;
	#model?: Model<any>;
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
	#tasks = new TaskList();
	#cadence = createCadenceState();
	#taskUnsubs: Array<() => void> = [];
	#snapshot: AgentSessionSnapshot = {
		messages: [],
		activities: [],
		queued: [],
		isRunning: false,
		compacting: false,
		usage: { tokens: 0, cost: 0 },
		contextTokens: 0,
		commands: resourceSlashCommands({}),
		tasks: [],
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
			tasks: [...this.#snapshot.tasks],
		};
	}

	get laneName(): string { return this.#lane?.name ?? "main"; }

	get model(): Model<any> | undefined {
		return this.#model;
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
		const created = await AgentHarness.create({
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
			compaction: compactionSettings(settings),
		}, context);
		this.#harness = created.harness;
		const lanes = await this.#harness.lanes(context);
		const laneName = lanes.find((lane) => lane.name === "main")?.name ?? lanes[0]?.name ?? "main";
		this.#lane = await this.#harness.lane(laneName, context);
		this.#model = await this.#lane.getModel(context) ?? model;
		const watch = await this.#lane.watch(context);
		this.#unsubscribe = watch.unsubscribe;
		watch.start((event) => this.#onEvent(event));
		this.#taskUnsubs.push(this.#harness.hooks.on("before_tool", async (event, toolContext) => {
			const decision = await this.mutationGate.request(event.toolName, event.args, this.workspace, this.#settings().permissionMode, toolContext.abortSignal ?? this.#runAbort.signal);
			return decision.block ? { block: { reason: decision.reason || "User denied this action." } } : undefined;
		}));
		// Never replay a previously interrupted mutation automatically on reopening.
		if (created.open.some((operation) => operation.lane === laneName)) await this.#lane.abort(context);
		this.#bindTaskRuntime();
		await this.#loadTasks();
		this.#snapshot = { ...this.#snapshot, commands: resourceSlashCommands(resources, settings), tasks: this.#tasks.list() };
		await this.#refreshContext();
		this.#publish();
	}

	async refreshTools(): Promise<void> {
		if (!this.#harness) return;
		const tools = this.#tools();
		await this.#harness.setTools(toHarnessTools(tools), context);
		await this.#requireLane().setActiveTools(tools.map((tool) => tool.name), context);
	}

	async reloadResources(): Promise<{ skills: string[]; prompts: string[]; roots: string[] }> {
		const harness = this.#requireHarness();
		const settings = this.#settings();
		const resources = await loadWorkspaceResources(this.workspace, settings.globalSkillRoots);
		this.#resources = resources;
		await harness.setResources(resources, context);
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
			harness.setSteeringMode(settings.steeringMode, context),
			harness.setFollowUpMode(settings.followUpMode, context),
			harness.setCompactionSettings(compactionSettings(settings), context),
			harness.setRetryPolicy(retryPolicy(settings), context),
			harness.setStreamOptions(streamOptions(settings), context),
		]);
		this.#snapshot = { ...this.#snapshot, commands: resourceSlashCommands(this.#resources, settings) };
		this.#publish();
	}

	async invokeResource(commandName: string, args: string): Promise<void> {
		const harness = this.#requireHarness();
		if (this.#running || this.#compacting) throw new Error("Wait for the current run to finish before starting a command.");
		const resources = await harness.getResources(context);
		this.#runAbort = new AbortController();
		this.#snapshot = { ...this.#snapshot, error: undefined };
		if (commandName.startsWith("skill:")) {
			const name = commandName.slice("skill:".length);
			if (!(resources.skills ?? []).some((skill) => skill.name.toLowerCase() === name.toLowerCase())) {
				throw new Error(`Unknown skill command: /${commandName}`);
			}
			assertOperation(getOrThrow(await this.#requireLane().skill(name, args || undefined, context)));
			return;
		}
		const template = (resources.promptTemplates ?? []).find((item) => item.name.toLowerCase() === commandName.toLowerCase());
		if (!template) throw new Error(`Unknown command: /${commandName}`);
		assertOperation(getOrThrow(await this.#requireLane().promptFromTemplate(template.name, parseCommandArgs(args), context)));
	}

	async compact(customInstructions?: string): Promise<void> {
		if (this.#running || this.#compacting) throw new Error("Wait for the current run to finish before compacting.");
		this.#requireHarness();
		this.#compacting = true;
		this.#publish();
		try {
			assertOperation(getOrThrow(await this.#requireLane().compact({ customInstructions: customInstructions?.trim() || undefined }, context)).compaction);
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
		await this.#pi.setName(next, context);
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
		const [entries, leafId] = await Promise.all([this.#pi.findEntries({ order: "asc" }, context), this.#requireLane().getTipId(context)]);
		const items = buildTreeItems(entries, leafId);
		return Promise.all(items.map(async (item) => ({ ...item, label: await this.#pi!.getLabel(item.id, context) })));
	}

	async navigateTree(targetId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<string | undefined> {
		if (this.#running || this.#compacting) throw new Error("Wait for the current run to finish before navigating the tree.");
		const selected = await this.#pi?.getEntry(targetId, context);
		const user = selected?.type === "message" && selected.message.role === "user" ? selected : undefined;
		const outcome = getOrThrow(await this.#requireLane().navigateTree(user ? user.parentId : targetId, options, context));
		assertOperation(outcome.navigation);
		await this.#refreshContext();
		await this.persist();
		this.#publish();
		return user && outcome.navigation.status === "completed" ? messagePlainText(user.message) : undefined;
	}

	async branchEntries(targetId?: string): Promise<Entry[]> {
		if (!this.#pi) return [];
		return this.#requireLane().findEntries({ ...(targetId ? { start: targetId } : {}), order: "oldestFirst" }, context);
	}

	async exportJsonl(): Promise<string> {
		await this.persist();
		return this.#store.export(this.id);
	}

	async prompt(text: string, mode: "steer" | "followUp" = "steer", images?: ImageContent[]): Promise<void> {
		const lane = this.#requireLane();
		const attachments = toPiImages(images ?? []);
		if (this.#running) {
			getOrThrow(await (mode === "followUp" ? lane.followUp(text, attachments, context) : lane.steer(text, attachments, context)));
			return;
		}
		if (this.#compacting) throw new Error("Wait for compaction to finish.");
		this.#runAbort = new AbortController();
		this.#beginRun();
		this.#publish();
		try {
			const result = getOrThrow(await lane.prompt(text, attachments, context));
			if (result.status === "failed") throw new Error(result.error?.message || "The model request failed.");
		} finally {
			this.#running = false;
			this.#settleActivities();
			await this.#refreshContext();
			await this.persist();
			this.#publish();
		}
	}

	async abort(): Promise<RestoredPrompt[]> {
		const harness = this.#harness;
		this.#runAbort.abort();
		this.questionGate.cancel();
		this.#running = false;
		this.#queued = [];
		this.#settleActivities();
		this.#publish();
		if (!harness) return [];
		try {
			const outcome = await this.#requireLane().abort(context);
			if (!outcome.ok) return [];
			const result = outcome.value;
			const restored = [...result.steer, ...result.followUp].map(restorePrompt).filter((item) => item.text || item.images.length);
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
		await this.#requireLane().setModel({ provider: model.provider, modelId: model.id }, context);
		this.#model = model;
		this.#persistMeta?.({ providerId: model.provider, modelId: model.id });
		this.#publish();
	}

	async setThinkingLevel(level: AgentSettings["thinkingLevel"]): Promise<void> {
		if (!this.#harness) return;
		await this.#requireLane().setThinkingLevel(level, context);
	}

	async persist(): Promise<void> {
		if (!this.#pi) return;
		this.title = await this.#pi.getName(context) || titleFromMessages(this.#messages);
		this.#persistMeta?.({
			title: this.title,
			providerId: this.#model?.provider,
			modelId: this.#model?.id,
		});
		await Promise.all([this.#flushPersist?.(), this.#store.saveTasks(this.id, this.#tasks.snapshot())]);
	}

	updateTaskStatus(id: string, status: TaskStatus | "deleted"): void {
		this.#tasks.updateStatus(id, status);
	}

	addTask(subject: string): Task {
		return this.#tasks.add(subject);
	}

	clearCompletedTasks(): number {
		return this.#tasks.clearCompleted();
	}

	clearAllTasks(): number {
		resetCadenceState(this.#cadence);
		return this.#tasks.clearAll();
	}

	async dispose(): Promise<void> {
		this.#runAbort.abort();
		this.questionGate.cancel();
		await this.#lane?.abort(context).catch(() => undefined);
		await this.#lane?.waitForIdle(context).catch(() => undefined);
		await this.persist().catch(() => undefined);
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#taskUnsubs.splice(0)) unsubscribe();
		this.mutationGate.dispose();
		this.questionGate.dispose();
		this.changes.clear();
		await this.#harness?.close(context);
		await this.#store.release(this.id);
		this.#lane = undefined;
		this.#harness = undefined;
		this.#pi = undefined;
	}

	async #onEvent(event: HarnessEvent): Promise<void> {
		this.#onAgentEvent(event);
		if (event.type === "queue_update") {
			this.#queued = event.queues.flatMap((item) => item.type === "message" && (item.kind === "steer" || item.kind === "followUp") ? [queuedFromMessage(item.message, item.kind)] : []);
		}
		if (event.type === "turn_start") {
			onTurnStart(this.#cadence);
			noteResolvedBoundary(this.#cadence, this.#tasks.list());
			if (shouldAutoClear(this.#cadence, this.#tasks.list())) this.#tasks.clearAll();
		}
		if (event.type === "turn_end") markStaleInProgress(this.#cadence, this.#tasks.list());
		if (event.type === "run_start") this.#beginRun();
		if (event.type === "run_end" || event.type === "operation_abort") {
			this.#running = false;
			this.#settleActivities();
			if (event.type === "operation_abort") this.#queued = [];
			await this.#refreshContext();
			await this.persist();
		}
		if (event.type === "compaction_end") {
			await this.#refreshContext();
			await this.persist();
		}
		if (event.type === "message_end" || event.type === "entry_added") await this.#refreshContext();
		if (event.type === "compaction_start") this.#compacting = true;
		if (event.type === "compaction_end") this.#compacting = false;
		if (event.type === "fault") this.#snapshot.error = event.message;
		if ((event.type === "run_end" || event.type === "compaction_end" || event.type === "navigation_end") && event.status === "failed") this.#snapshot.error = event.error.message;
		this.#publish();
	}

	#onAgentEvent(event: HarnessEvent): void {
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
		if (event.type === "tool_start") {
			this.#activities.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: sanitizeArgs(event.args),
				status: "running",
				startedAt: Date.now(),
			});
		}
		if (event.type === "tool_update") {
			const activity = this.#activities.get(event.toolCallId);
			if (activity) activity.summary = toolResultText(event.partialResult);
		}
		if (event.type === "tool_end") {
			const activity = this.#activities.get(event.toolCallId);
			if (activity) {
				activity.status = event.isError ? "error" : "done";
				activity.summary = toolResultText(event.result);
				activity.endedAt = Date.now();
				if (event.isError) activity.error = activity.summary;
			}
		}
	}

	async #refreshContext(): Promise<void> {
		if (!this.#pi || !this.#lane) return;
		const [entries, stats] = await Promise.all([
			this.#lane.findEntries({ stopAtType: "compaction", order: "oldestFirst" }, context),
			this.#pi.getStats(context),
		]);
		// Projection for the transcript only; Pi constructs provider context itself.
		this.#messages = entries.flatMap((entry): AgentMessage[] => {
			if (entry.type === "message") return [entry.message];
			if (entry.type === "compaction") return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail];
			if (entry.type === "branch_summary") return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
			return [];
		});
		this.#snapshot = { ...this.#snapshot, usage: { tokens: stats.usage.totalTokens, cost: stats.usage.cost.total }, contextTokens: estimateContextTokens(this.#messages).tokens };
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
			tasks: this.#tasks.list(),
			error: overrides?.error ?? this.#snapshot.error,
		};
		this.changes.emit(this.snapshot);
	}

	#tools(): AgentTool[] {
		const bash = createTerminalBashTool(this.workspace);
		return [
			...createWorkspaceTools(this.workspace, {
				maxWalkFiles: () => this.#settings().maxWalkFiles,
				autoResizeImages: () => this.#settings().imageAutoResize,
			}),
			...(bash ? [bash] : []),
			...createTaskTools(this.#tasks),
			createAskTool(this.questionGate),
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
			const skills = this.#resources.skills ?? [];
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

	#requireLane(): AgentLane {
		if (!this.#lane) throw new Error("Agent session has not been initialized.");
		return this.#lane;
	}

	#requireHarness(): AgentHarness<undefined> {
		if (!this.#harness) throw new Error("Agent session has not been initialized.");
		return this.#harness;
	}

	async #loadTasks(): Promise<void> {
		try {
			this.#tasks.restore(parseTaskStore(await this.#store.loadTasks(this.id)));
		} catch (error) {
			console.warn("AI task list could not be restored", error);
		}
	}

	#bindTaskRuntime(): void {
		const harness = this.#harness;
		if (!harness) return;
		this.#taskUnsubs.push(
			this.#tasks.subscribe(() => {
				void this.#store.saveTasks(this.id, this.#tasks.snapshot()).catch((error) => {
					console.warn("AI task list could not be persisted", error);
				});
				this.#publish();
			}),
			harness.hooks.on("after_tool", (event) => {
				evaluateReminder(this.#cadence, event.toolName, this.#tasks.list());
				return undefined;
			}),
			harness.hooks.on("transform_context", (event) => this.#injectTaskReminder(event.messages)),
		);
	}

	#injectTaskReminder(messages: AgentMessage[]): { messages: AgentMessage[] } | undefined {
		try {
			if (!drainReminder(this.#cadence)) return undefined;
			const tasks = this.#tasks.list();
			const reminder = buildTaskReminder(tasks);
			if (!reminder) return undefined;
			const last = messages.at(-1);
			if (last && last.role === "user" && messagePlainText(last).includes("<system-reminder>")) return undefined;
			return {
				messages: [...messages, { role: "user", content: reminder, timestamp: Date.now() }],
			};
		} catch (error) {
			console.warn("AI task reminder could not be injected", error);
			return undefined;
		}
	}
}

function toHarnessTools(tools: AgentTool[]): AgentHarnessTool<undefined>[] {
	return tools.map((tool) => ({
		...tool,
		execute: (toolCallId, params, onUpdate, _toolContext, _invocation, context) => tool.execute(toolCallId, params, context.abortSignal, onUpdate),
	}));
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
	if (Array.isArray(value.todos)) value.todos = value.todos.map(summarizeTodoArg);
	if (Array.isArray(value.questions)) value.questions = value.questions.map(summarizeQuestionArg);
	return value;
}

function summarizeTodoArg(item: unknown): Record<string, unknown> {
	if (!item || typeof item !== "object") return {};
	const todo = item as Record<string, unknown>;
	return {
		id: todo.id,
		status: todo.status,
		content: typeof todo.content === "string" ? todo.content.slice(0, 80) : todo.content,
	};
}

function summarizeQuestionArg(item: unknown): Record<string, unknown> {
	if (!item || typeof item !== "object") return {};
	const question = item as Record<string, unknown>;
	const options = Array.isArray(question.options)
		? question.options.map((option) => {
			if (!option || typeof option !== "object") return {};
			const entry = option as Record<string, unknown>;
			return {
				label: typeof entry.label === "string" ? entry.label.slice(0, 60) : entry.label,
				description: typeof entry.description === "string" ? entry.description.slice(0, 80) : undefined,
			};
		})
		: undefined;
	return {
		header: question.header,
		question: typeof question.question === "string" ? question.question.slice(0, 80) : question.question,
		multiSelect: question.multiSelect,
		options,
	};
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

function buildTreeItems(entries: Entry[], leafId: string | null): SessionTreeItem[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
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
			timestamp: new Date(entry.timestamp).toISOString(),
			active: activeIds.has(entry.id),
			current: entry.id === currentId,

		};
	});
}

function describeTreeEntry(entry: Entry): Pick<SessionTreeItem, "kind" | "text"> {
	if (entry.type === "message") {
		const role = entry.message.role;
		return {
			kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "tool",
			text: agentMessageText(entry.message) || (role === "assistant" ? "Assistant response" : role === "user" ? "User prompt" : "Tool result"),
		};
	}
	if (entry.type === "compaction") return { kind: "summary", text: `Compaction · ${entry.summary}` };
	if (entry.type === "branch_summary") return { kind: "summary", text: `Branch summary · ${entry.summary}` };
	if (entry.type === "custom") return { kind: "state", text: `Custom · ${entry.customType}` };
	return { kind: "state", text: "Session entry" };
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

function compactionSettings(settings: AgentSettings) {
	return { ...DEFAULT_COMPACTION_SETTINGS, enabled: settings.autoCompaction, reserveTokens: settings.compactionReserveTokens, keepRecentTokens: settings.compactionKeepRecentTokens };
}

function assertOperation(result: { status: string; error?: { message: string } }): void {
	if (result.status === "failed") throw new Error(result.error?.message || "Pi operation failed.");
}
