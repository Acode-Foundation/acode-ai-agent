import type { AttachedReplicatedState, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Type,
  type AssistantMessage,
  type ImageContent,
  type Message,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  ToolTask,
  UserEntry,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryDraft,
  type EntryId,
  type HarnessSettings,
  type InboxState,
  type LiveState,
  type Registry,
  type Submission,
  type ToolRegistration,
  type UsageState,
} from "@earendil-works/pi-durable";
import { createAskTool } from "../ask/createAskTool";
import { QuestionGate } from "../ask/questionGate";
import { systemPromptSections } from "../context/contextBuilder";
import { Signal } from "../core/events";
import type { ExtensionRegistry } from "../core/extensionRegistry";
import { resourceSlashCommands, type SlashCommand } from "../core/slashCommands";
import type {
  AgentSettings,
  QueuedPrompt,
  RestoredPrompt,
  RunRecovery,
  RunRetry,
  SessionTreeItem,
  ToolActivity,
  TranscriptMessage,
} from "../core/types";
import type { MutationGate } from "../permissions/mutationGate";
import { toPiImages } from "../platform/promptImages";
import type { ProviderRegistry } from "../providers/providerRegistry";
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
import { createWorkspaceTools, withReadableErrors } from "../tools/createTools";
import { editPairs } from "../tools/textEdits";
import { createWebSearchContext } from "../tools/web/context";
import { createWebTools } from "../tools/web/createWebTools";
import { WorkspaceExecutionEnv } from "../tools/workspaceEnv";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import type { ChatMeta, ChatStore } from "./chatStore";
import {
  appendHistory,
  buildTreeItems,
  historyEntries,
  latestAssistantText,
  toPiSessionJsonl,
  transcriptFromEntries,
} from "./history";
import {
  expandPromptTemplate,
  parseCommandArgs,
  skillInvocation,
  type WorkspaceResources,
} from "./promptTemplates";
import { messageImages, messagePlainText, titleFromMessages } from "./sessionText";
import { loadWorkspaceResources } from "./workspaceResources";

export type AgentSessionSnapshot = {
  messages: TranscriptMessage[];
  streamingMessage?: AssistantMessage;
  activities: ToolActivity[];
  queued: QueuedPrompt[];
  isRunning: boolean;
  compacting: boolean;
  usage: { tokens: number; cost: number };
  contextTokens: number;
  commands: SlashCommand[];
  tasks: Task[];
  recovery?: RunRecovery;
  retry?: RunRetry;
  error?: string;
};

/** The session task list, stored with the conversation so it follows forks and restarts. */
const TasksDoc = defineDoc<{ store: JsonValue }>({
  kind: "acode.tasks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ store: null }),
});

/**
 * One chat: a Pi durable Harness over the chat's own storage. Pi owns the transcript,
 * runs, tool calls, queues, retries, and compaction, and commits each step before it is
 * shown. This class wires Acode's tools, prompts, and approvals into it and projects the
 * active conversation's view for the UI.
 */
export class AgentSession {
  readonly id: string;
  readonly changes = new Signal<AgentSessionSnapshot>();
  readonly mutationGate: MutationGate;
  readonly questionGate = new QuestionGate();
  readonly workspace: AcodeWorkspace;
  #meta: ChatMeta;
  #providers: ProviderRegistry;
  #extensions: ExtensionRegistry;
  #settings: () => AgentSettings;
  #store: ChatStore;
  #env: WorkspaceExecutionEnv;
  #registry: Registry = createRegistry();
  #harness?: Harness;
  #conversation?: Conversation;
  #view?: AttachedReplicatedState<ConversationView>;
  #unsubscribeView?: () => void;
  #resources: WorkspaceResources = { skills: [], promptTemplates: [], skillRoots: [] };
  #tasks = new TaskList();
  #cadence = createCadenceState();
  #unsubscribers: Array<() => void> = [];
  #toolStarts = new Map<string, number>();
  #recovery?: RunRecovery;
  #runError?: string;
  #persistTasks: Promise<void> = Promise.resolve();
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
    meta: ChatMeta;
    workspace: AcodeWorkspace;
    providers: ProviderRegistry;
    extensions: ExtensionRegistry;
    settings: () => AgentSettings;
    store: ChatStore;
    mutationGate: MutationGate;
  }) {
    this.id = options.meta.id;
    this.#meta = { ...options.meta };
    this.workspace = options.workspace;
    this.#providers = options.providers;
    this.#extensions = options.extensions;
    this.#settings = options.settings;
    this.#store = options.store;
    this.mutationGate = options.mutationGate;
    this.#env = new WorkspaceExecutionEnv(options.workspace);
  }

  get title(): string {
    return this.#meta.title;
  }

  get meta(): ChatMeta {
    return { ...this.#meta };
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

  async initialize(): Promise<void> {
    const settings = this.#settings();
    this.#resources = await loadWorkspaceResources(this.workspace, settings.globalSkillRoots);
    this.#installExtensions();
    const storage = await this.#store.openStorage(this.id);
    this.#harness = await Harness.open(
      storage,
      {
        models: this.#providers.harnessModels,
        registry: this.#registry,
        settings: harnessSettings(this.#settings),
        env: () => this.#env,
        onReport: (error) => console.warn("Pi harness report", error),
      },
      context,
    );
    const stored =
      this.#meta.conversationId === undefined
        ? undefined
        : await this.#harness.conversation(this.#meta.conversationId as ConversationId, context);
    const conversation = stored ?? (await this.#harness.root(context));
    // Work the previous app session left running waits for the user to resume it.
    const inspection = await this.#harness.inspect(context);
    const interrupted = inspection.tasks.find((task) => task.state.kind !== "blocked");
    if (interrupted) {
      this.#recovery = {
        kind: "interrupted",
        operation: interrupted.record.kind === "pi.compaction" ? "compaction" : "run",
        message:
          "This chat was interrupted when the app closed. Resume to continue from Pi's last durable checkpoint.",
      };
    } else this.#harness.resume();
    this.#unsubscribers.push(
      this.#tasks.subscribe(() => {
        this.#saveTasks();
        this.#publish();
      }),
    );
    await this.#activate(conversation);
    await this.applyModel(settings.providerId, settings.modelId, settings.thinkingLevel);
  }

  /** Point the chat at its model; Pi stores the choice on the conversation. */
  async applyModel(
    providerId: string,
    modelId: string,
    thinkingLevel: AgentSettings["thinkingLevel"],
  ): Promise<void> {
    const conversation = this.#conversation;
    if (!conversation) return;
    const agent = await conversation.agent(context);
    if (
      agent.model?.provider === providerId &&
      agent.model.modelId === modelId &&
      agent.thinkingLevel === thinkingLevel
    )
      return;
    await conversation.configure(
      { model: { provider: providerId, modelId }, thinkingLevel },
      context,
    );
  }

  refreshTools(): void {
    this.#installExtensions();
  }

  async reloadResources(): Promise<{ skills: string[]; prompts: string[]; roots: string[] }> {
    const settings = this.#settings();
    this.#resources = await loadWorkspaceResources(this.workspace, settings.globalSkillRoots);
    this.#installExtensions();
    this.#publish();
    return {
      skills: this.#resources.skills.map((skill) => skill.name),
      prompts: this.#resources.promptTemplates.map((prompt) => prompt.name),
      roots: this.#resources.skillRoots,
    };
  }

  applySettings(): void {
    // Harness settings are read live through getters; only derived UI state changes here.
    this.#publish();
  }

  /** `/skill:name` and prompt templates become an ordinary user message. */
  async invokeResource(commandName: string, args: string): Promise<void> {
    if (commandName.startsWith("skill:")) {
      const name = commandName.slice("skill:".length).toLowerCase();
      const skill = this.#resources.skills.find((item) => item.name.toLowerCase() === name);
      if (!skill) throw new Error(`Unknown skill command: /${commandName}`);
      await this.prompt(skillInvocation(skill, args), "followUp");
      return;
    }
    const template = this.#resources.promptTemplates.find(
      (item) => item.name.toLowerCase() === commandName.toLowerCase(),
    );
    if (!template) throw new Error(`Unknown command: /${commandName}`);
    await this.prompt(expandPromptTemplate(template.content, parseCommandArgs(args)), "followUp");
  }

  async compact(instructions?: string): Promise<void> {
    const harness = this.#requireHarness();
    const task = await this.#requireConversation().compact(
      instructions?.trim() || undefined,
      context,
    );
    const settled = await harness.waitForTask(task, context);
    const outcome = settled.state.outcome;
    if (outcome.status === "failed" || outcome.status === "faulted")
      throw new Error(outcome.error.message || "Compaction failed.");
    if (outcome.status === "completed" && !outcome.result.entryId && !outcome.result.submissionId)
      throw new Error("Nothing to compact yet.");
  }

  async rename(name: string): Promise<void> {
    const next = name.replace(/[\r\n]+/g, " ").trim();
    if (!next) throw new Error("Add a name after /name.");
    await this.#saveMeta({ title: next });
    this.#publish();
  }

  latestAssistantText(): string {
    return latestAssistantText(this.#snapshot.messages);
  }

  sessionInfo(): { id: string; title: string; tokens: number; cost: number } {
    return {
      id: this.id,
      title: this.title,
      tokens: this.#snapshot.usage.tokens,
      cost: this.#snapshot.usage.cost,
    };
  }

  async treeItems(): Promise<SessionTreeItem[]> {
    if (!this.#harness || !this.#conversation) return [];
    return buildTreeItems(this.#harness, this.#conversation.id, context);
  }

  /**
   * Switch to another point of the chat's tree. Picking a user message branches just
   * before it and returns its text for the composer; picking any other entry continues
   * from there, reusing the branch that already ends at it.
   */
  async navigateTree(target: string): Promise<string | undefined> {
    const harness = this.#requireHarness();
    this.#assertIdle("navigating the tree");
    const entryId = Number(target) as EntryId;
    const owner = await this.#ownerOf(entryId);
    if (!owner) throw new Error("That message is no longer in this chat.");
    const history = await historyEntries(owner, context, entryId);
    const entry = history.at(-1);
    if (!entry || entry.id !== entryId) throw new Error("That message is no longer in this chat.");
    if (UserEntry.is(entry)) {
      const before = history.at(-2);
      const next = before
        ? await this.#branchAt(owner, before.id)
        : await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      await this.#activate(next);
      return messagePlainText(entry.model![0]!);
    }
    await this.#activate(await this.#branchAt(owner, entryId));
    return undefined;
  }

  /** Visible history up to an entry (or all of it), for copying into another chat. */
  async historyUntil(target?: string): Promise<{ entries: EntryDraft[]; restoredText?: string }> {
    const conversation = this.#requireConversation();
    if (target === undefined) return { entries: await historyEntries(conversation, context) };
    const entryId = Number(target) as EntryId;
    const owner = await this.#ownerOf(entryId);
    if (!owner) throw new Error("That message is no longer in this chat.");
    const history = await historyEntries(owner, context, entryId);
    const entry = history.at(-1);
    if (!entry || entry.id !== entryId || !UserEntry.is(entry))
      throw new Error("Forks must start from a user message.");
    return { entries: history.slice(0, -1), restoredText: messagePlainText(entry.model![0]!) };
  }

  /** Seed a new, empty chat with copied history. */
  async importHistory(entries: readonly EntryDraft[]): Promise<void> {
    await appendHistory(this.#requireHarness(), this.#requireConversation().id, entries, context);
    if (this.#meta.title === "New chat")
      await this.#saveMeta({ title: titleFromMessages(transcriptFromEntries(entries as never)) });
    this.#publish();
  }

  taskSnapshot(): ReturnType<TaskList["snapshot"]> {
    return this.#tasks.snapshot();
  }

  restoreTasks(store: ReturnType<TaskList["snapshot"]>): void {
    this.#tasks.restore(store);
    this.#saveTasks();
    this.#publish();
  }

  async exportJsonl(): Promise<string> {
    const entries = await historyEntries(this.#requireConversation(), context);
    return toPiSessionJsonl(entries, { id: this.id, createdAt: this.#meta.createdAt });
  }

  async prompt(
    text: string,
    mode: "steer" | "followUp" = "steer",
    images?: ImageContent[],
  ): Promise<void> {
    const conversation = this.#requireConversation();
    const attachments = toPiImages(images ?? []);
    const content = attachments.length
      ? [...(text ? [{ type: "text" as const, text }] : []), ...attachments]
      : text;
    this.#runError = undefined;
    // Sending resumes any interrupted work first, then queues behind it.
    this.#recovery = undefined;
    const submission = await conversation.submit(
      { type: "input", content, whenBusy: mode },
      context,
    );
    this.#publish();
    void this.#followSubmission(submission);
  }

  /** Stop the run and withdraw queued prompts, returning them so the composer can restore them. */
  async abort(): Promise<RestoredPrompt[]> {
    const conversation = this.#conversation;
    this.questionGate.cancel();
    if (!conversation) return [];
    const inbox = this.#view?.value.docs["pi.inbox"] as unknown as InboxState | undefined;
    const restored = (inbox?.items ?? []).flatMap((item) =>
      item.mode === "write" ? [] : [restorePrompt(item.content)],
    );
    this.#recovery = undefined;
    this.#publish();
    try {
      await conversation.abort(context);
    } catch (error) {
      this.#runError = error instanceof Error ? error.message : String(error);
    }
    this.#publish();
    return restored.filter((item) => item.text || item.images.length);
  }

  async resume(): Promise<void> {
    if (!this.#recovery) throw new Error("There is no interrupted run to resume.");
    this.#recovery = undefined;
    this.#runError = undefined;
    this.#requireHarness().resume();
    this.#publish();
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
    this.questionGate.cancel();
    this.#unsubscribeView?.();
    this.#view?.dispose();
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.mutationGate.dispose();
    this.questionGate.dispose();
    this.changes.clear();
    await this.#persistTasks.catch(() => undefined);
    // Closing keeps unfinished work durable; it resumes when the chat is opened again.
    await this.#harness?.close(context).catch((error) => console.warn("Pi harness close", error));
    this.#harness = undefined;
    this.#conversation = undefined;
  }

  async #activate(conversation: Conversation): Promise<void> {
    this.#unsubscribeView?.();
    this.#view?.dispose();
    this.#conversation = conversation;
    if (this.#meta.conversationId !== conversation.id)
      await this.#saveMeta({ conversationId: conversation.id }, false);
    await this.#loadTasks();
    const view = await conversation.viewState(context);
    this.#view = view;
    this.#unsubscribeView = view.subscribe(() => this.#publish());
    this.#publish();
  }

  async #branchAt(owner: Conversation, entryId: EntryId): Promise<Conversation> {
    const harness = this.#requireHarness();
    // Reuse a branch that already ends at this entry instead of forking it again.
    const existing = await harness.commit(async (tx) => {
      const page = await tx.scanConversations({}, 1000);
      for (const record of page.items) {
        if (record.owner) continue;
        const latest = await tx.scanEntries({ conversationId: record.id }, 1);
        if (latest.items[0]?.id === entryId) return record.id;
      }
      return undefined;
    }, context);
    if (existing !== undefined) {
      const conversation = await harness.conversation(existing, context);
      if (conversation) return conversation;
    }
    return owner.fork(entryId, { ownership: { kind: "ownerless" } }, context);
  }

  /** A conversation that owns the entry, so a fork from it can see it. */
  async #ownerOf(entryId: EntryId): Promise<Conversation | undefined> {
    const harness = this.#requireHarness();
    const conversationId = await harness.commit(
      async (tx) => (await tx.entry(entryId))?.conversationId,
      context,
    );
    return conversationId === undefined ? undefined : harness.conversation(conversationId, context);
  }

  async #followSubmission(submission: Submission): Promise<void> {
    try {
      const settled = await submission.wait(context);
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        this.#runError = describeUnanswered(settled.reason, settled.detail);
      }
      if (this.#meta.title === "New chat") {
        const title = titleFromMessages(this.#snapshot.messages);
        if (title !== "New chat") await this.#saveMeta({ title });
      }
      await this.#saveMeta({});
    } catch (error) {
      this.#runError = error instanceof Error ? error.message : String(error);
    }
    this.#publish();
  }

  #installExtensions(): void {
    const tools = [
      ...createWorkspaceTools(this.workspace, {
        maxWalkFiles: () => this.#settings().maxWalkFiles,
        autoResizeImages: () => this.#settings().imageAutoResize,
        fileOperations: !this.#env.shell,
        bash: Boolean(this.#env.shell),
      }),
      ...[
        ...createTaskTools(this.#tasks),
        createAskTool(this.questionGate),
        this.#skillTool(),
        ...createWebTools(
          createWebSearchContext({ models: this.#providers.models, settings: this.#settings }),
        ),
      ].map(withReadableErrors),
    ];
    this.#registry.install(
      defineExtension({
        name: "acode",
        tools,
        sections: systemPromptSections({
          workspace: this.workspace,
          settings: this.#settings,
          extensions: this.#extensions,
          skills: () => this.#resources.skills,
        }),
        hooks: [
          hook(ToolTask, {
            beforeTool: async (call, _api, toolContext) => {
              const decision = await this.mutationGate.request(
                call.name,
                call.arguments,
                this.workspace,
                this.#settings().permissionMode,
                toolContext.abortSignal,
              );
              return decision.block
                ? { block: decision.reason || "User denied this action." }
                : undefined;
            },
            afterTool: (call) => {
              evaluateReminder(this.#cadence, call.name, this.#tasks.list());
              return undefined;
            },
          }),
          hook(GenerationTask, {
            beforeRequest: (request) => this.#beforeRequest(request.messages),
          }),
        ],
      }),
    );
    this.#registry.install(
      defineExtension({ name: "plugins", tools: this.#extensions.tools.map(withReadableErrors) }),
    );
  }

  /** Each request starts a task-list turn and may carry a reminder the model sees only once. */
  #beforeRequest(messages: readonly Message[]): { messages: readonly Message[] } | undefined {
    try {
      const tasks = this.#tasks.list();
      if (this.#cadence.currentTurn > 0) markStaleInProgress(this.#cadence, tasks);
      onTurnStart(this.#cadence);
      noteResolvedBoundary(this.#cadence, tasks);
      if (shouldAutoClear(this.#cadence, tasks)) this.#tasks.clearAll();
      if (!drainReminder(this.#cadence)) return undefined;
      const reminder = buildTaskReminder(this.#tasks.list());
      if (!reminder) return undefined;
      const last = messages.at(-1);
      if (last?.role === "user" && messagePlainText(last).includes("<system-reminder>"))
        return undefined;
      return {
        messages: [...messages, { role: "user", content: reminder, timestamp: Date.now() }],
      };
    } catch (error) {
      console.warn("AI task reminder could not be injected", error);
      return undefined;
    }
  }

  #skillTool(): ToolRegistration {
    return defineTool({
      name: "load_skill",
      description:
        "Load an already-discovered project or global skill, or one of its relative reference files. Do not search the workspace for SKILL.md first; global skills are outside the workspace sandbox.",
      parameters: Type.Object({
        name: Type.String({ description: "Skill name from available_skills" }),
        path: Type.Optional(
          Type.String({
            description:
              "Optional file path relative to the skill folder, such as references/api.md",
          }),
        ),
      }),
      executionMode: "parallel",
      replay: "safe",
      execute: async (args) => {
        const skill = this.#resources.skills.find(
          (item) => item.name.toLowerCase() === args.name.toLowerCase(),
        );
        if (!skill) throw new Error(`Unknown skill: ${args.name}`);
        const relativePath = normalizeSkillPath(args.path);
        const text = relativePath
          ? await readSkillRelativeFile(this.workspace, skill.filePath, relativePath)
          : skill.content;
        return {
          content: [
            {
              type: "text",
              text: `<skill name="${skill.name}" location="${skill.filePath}"${relativePath ? ` file="${relativePath}"` : ""}>\n${text}\n</skill>`,
            },
          ],
          details: { name: skill.name, path: relativePath || skill.filePath },
        };
      },
    });
  }

  #publish(): void {
    const view = this.#view?.value;
    const live = view?.docs["pi.live"] as unknown as LiveState | undefined;
    const inbox = view?.docs["pi.inbox"] as unknown as InboxState | undefined;
    const usage = view?.docs["pi.usage"] as unknown as UsageState | undefined;
    const entries = view?.entries ?? [];
    const messages = transcriptFromEntries(entries);
    const running = Boolean(live?.run);
    const compacting = Boolean(live?.compactions?.length);
    const streaming = live?.generation?.message as AssistantMessage | undefined;
    const retry = live?.generation?.retry;
    const settings = this.#settings();
    this.#snapshot = {
      messages,
      streamingMessage: running ? streaming : undefined,
      activities: this.#activities(live, messages, streaming),
      queued: (inbox?.items ?? []).flatMap((item) =>
        item.mode === "write" ? [] : [queuedPrompt(item.content, item.mode)],
      ),
      isRunning: running || Boolean(live?.compactions?.some((item) => item.blocking)),
      compacting,
      usage: totalUsage(usage),
      contextTokens: estimateContextTokens(
        entries.flatMap((entry) => entry.model ?? []) as Message[],
      ).tokens,
      commands: resourceSlashCommands(this.#resources, settings),
      tasks: this.#tasks.list(),
      recovery: this.#recovery,
      retry:
        retry && live?.generation
          ? {
              attempt: live.generation.attempt,
              maxAttempts: settings.retryMaxRetries + 1,
              errorMessage: retry.error,
            }
          : undefined,
      error: this.#runError ?? lastTurnError(messages),
    };
    this.changes.emit(this.snapshot);
  }

  #activities(
    live: LiveState | undefined,
    messages: TranscriptMessage[],
    streaming: AssistantMessage | undefined,
  ): ToolActivity[] {
    const slots = live?.tools ?? [];
    if (!slots.length) {
      this.#toolStarts.clear();
      return [];
    }
    const calls = new Map<string, Record<string, unknown>>();
    for (const message of [...messages.slice(-4), ...(streaming ? [streaming] : [])]) {
      if (message.role !== "assistant") continue;
      for (const part of message.content)
        if (part.type === "toolCall") calls.set(part.id, part.arguments as Record<string, unknown>);
    }
    return slots.map((slot) => {
      const startedAt = this.#toolStarts.get(slot.callId) ?? Date.now();
      this.#toolStarts.set(slot.callId, startedAt);
      const summary = slot.output?.slice(-300);
      const failed = slot.diagnostics?.some((item) => item.severity === "error");
      return {
        id: slot.callId,
        name: slot.name,
        args: sanitizeArgs(calls.get(slot.callId)),
        status: slot.status === "done" ? (failed ? "error" : "done") : "running",
        summary,
        error: failed
          ? slot.diagnostics?.find((item) => item.severity === "error")?.message
          : undefined,
        startedAt,
      };
    });
  }

  async #loadTasks(): Promise<void> {
    const harness = this.#harness;
    const conversation = this.#conversation;
    if (!harness || !conversation) return;
    try {
      const stored = await harness.snapshot(TasksDoc, conversation.id, context);
      this.#tasks.restore(parseTaskStore(stored?.store ?? undefined));
    } catch (error) {
      console.warn("AI task list could not be restored", error);
    }
  }

  #saveTasks(): void {
    const harness = this.#harness;
    const conversation = this.#conversation;
    if (!harness || !conversation) return;
    const store = JSON.parse(JSON.stringify(this.#tasks.snapshot())) as JsonValue;
    this.#persistTasks = this.#persistTasks
      .catch(() => undefined)
      .then(() =>
        conversation.commit(async (tx) => {
          (await tx.doc(TasksDoc, conversation.id)).store = store;
        }, context),
      )
      .catch((error) => console.warn("AI task list could not be persisted", error));
  }

  async #saveMeta(patch: Partial<ChatMeta>, activity = true): Promise<void> {
    this.#meta = { ...this.#meta, ...patch, ...(activity ? { updatedAt: Date.now() } : {}) };
    await this.#store.save(this.#meta);
  }

  #assertIdle(action: string): void {
    if (this.#snapshot.isRunning || this.#snapshot.compacting)
      throw new Error(`Wait for the current run to finish before ${action}.`);
  }

  #requireHarness(): Harness {
    if (!this.#harness) throw new Error("Agent session has not been initialized.");
    return this.#harness;
  }

  #requireConversation(): Conversation {
    if (!this.#conversation) throw new Error("Agent session has not been initialized.");
    return this.#conversation;
  }
}

/** Harness policy read live from the settings store. */
function harnessSettings(settings: () => AgentSettings): HarnessSettings {
  return {
    get stream() {
      const value = settings();
      return {
        transport: value.transport,
        timeoutMs: value.providerTimeoutMs,
        maxRetries: value.providerMaxRetries,
        maxRetryDelayMs: value.providerMaxRetryDelayMs,
      };
    },
    get retry() {
      const value = settings();
      return {
        enabled: value.retryEnabled,
        maxRetries: value.retryMaxRetries,
        baseDelayMs: value.retryBaseDelayMs,
      };
    },
    get compaction() {
      const value = settings();
      return {
        enabled: value.autoCompaction,
        reserveTokens: value.compactionReserveTokens,
        keepRecentTokens: value.compactionKeepRecentTokens,
      };
    },
    // Fewer storage commits while streaming; a crash loses at most this much output.
    progress: { partialIntervalMs: 150, outputIntervalMs: 250 },
    get steeringMode() {
      return settings().steeringMode;
    },
    get followUpMode() {
      return settings().followUpMode;
    },
  };
}

function totalUsage(usage: UsageState | undefined): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
    for (const item of Object.values(bucket)) {
      tokens += item.totalTokens ?? 0;
      cost += item.cost?.total ?? 0;
    }
  }
  return { tokens, cost };
}

/** A provider failure the user should see: the newest answer after the newest prompt failed. */
function lastTurnError(messages: TranscriptMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return undefined;
    if (message.role !== "assistant") continue;
    return message.stopReason === "error"
      ? message.errorMessage?.trim() || "The model request failed."
      : undefined;
  }
  return undefined;
}

function describeUnanswered(reason: string, detail: unknown): string {
  const message =
    detail && typeof detail === "object" && "message" in detail
      ? String((detail as { message: unknown }).message)
      : undefined;
  return message || `The prompt was not answered (${reason}).`;
}

type InboxContent =
  | string
  | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

function restorePrompt(content: unknown): RestoredPrompt {
  const message = { role: "user", content } as const;
  return { text: messagePlainText(message), images: messageImages(message) };
}

function queuedPrompt(content: unknown, mode: QueuedPrompt["mode"]): QueuedPrompt {
  const message = { role: "user", content: content as InboxContent } as const;
  const images = messageImages(message).length;
  return { text: messagePlainText(message), mode, images: images || undefined };
}

function sanitizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const value = { ...(args as Record<string, unknown>) };
  if ("content" in value) value.content = `[${String(value.content).length} characters]`;
  if ("new_string" in value) value.new_string = `[${String(value.new_string).length} characters]`;
  if ("old_string" in value) value.old_string = `[${String(value.old_string).length} characters]`;
  if (Array.isArray(value.edits))
    value.edits = value.edits.map((edit) => {
      const pair = editPairs({ edits: [edit] })[0];
      return pair
        ? {
            oldText: `[${pair.oldText.length} characters]`,
            newText: `[${pair.newText.length} characters]`,
          }
        : {};
    });
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
          description:
            typeof entry.description === "string" ? entry.description.slice(0, 80) : undefined,
        };
      })
    : undefined;
  return {
    header: question.header,
    question:
      typeof question.question === "string" ? question.question.slice(0, 80) : question.question,
    multiSelect: question.multiSelect,
    options,
  };
}

function normalizeSkillPath(value: string | undefined): string {
  const path = value?.trim().replace(/\\/g, "/").replace(/^\.\//, "") ?? "";
  if (!path) return "";
  if (path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error("Skill reference paths must stay inside the skill folder.");
  }
  return path.replace(/\/+/g, "/");
}

async function readSkillRelativeFile(
  workspace: AcodeWorkspace,
  skillFilePath: string,
  relativePath: string,
): Promise<string> {
  const slash = skillFilePath.lastIndexOf("/");
  const base = slash >= 0 ? skillFilePath.slice(0, slash) : "";
  if (skillFilePath.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(skillFilePath)) {
    return acode.fsOperation(acode.joinUrl(base, relativePath)).readFile("utf-8");
  }
  return workspace.readText([base, relativePath].filter(Boolean).join("/"));
}
