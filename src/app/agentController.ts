import type { AgentTool, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AuthEvent, ImageContent, Model, Provider } from "@earendil-works/pi-ai";
import { Signal } from "../core/events";
import { BUILT_IN_SLASH_COMMANDS } from "../core/slashCommands";
import { ExtensionRegistry, type ContextContribution } from "../core/extensionRegistry";
import { SettingsStore } from "../core/settings";
import type { PermissionMode } from "../core/schema";
import type {
	AgentFeature,
	AgentSettings,
	ChatSummary,
	MutationDecision,
	ProviderId,
	PublicAgentState,
	RestoredPrompt,
	SessionTreeItem,
	WorkspaceInfo,
} from "../core/types";
import { openAcodeUri } from "../platform/deviceImage";
import { collectPromptImages } from "../platform/promptImages";
import { MutationGate } from "../permissions/mutationGate";
import { openAuthTab } from "../platform/authTab";
import { PortableCredentialStore } from "../platform/credentials";
import { createSessionStore, type SessionStore } from "../platform/sessionStore";
import { createChatId, messagePlainText } from "../session/sessionText";
import { ProviderRegistry } from "../providers/providerRegistry";
import { AgentSession } from "../session/agentSession";
import { pickGlobalSkillsFolder } from "../session/workspaceResources";
import { sanitizeModelId } from "../providers/customModels";
import { clampThinkingLevel } from "../providers/thinkingLevels";
import { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { searchWorkspaceFiles, type MentionFile } from "../workspace/fileMentions";
import { getAvailableWorkspaces, subscribeToSidebarFolders } from "../workspace/sidebarFolders";
import { subscribeToSourceFiles } from "../workspace/sourceFile";

export class AgentController {
	readonly changes = new Signal<PublicAgentState>();
	readonly settings = new SettingsStore();
	readonly credentials: PortableCredentialStore;
	readonly providers: ProviderRegistry;
	readonly extensions = new ExtensionRegistry();
	#sessionStore: SessionStore;
	#sessions = new Map<string, AgentSession>();
	#sessionListeners = new Map<string, () => void>();
	#activeId?: string;
	#uiUnsubscribers: Array<() => void> = [];
	#hostUnsubscribers: Array<() => void> = [];
	#authAbort?: AbortController;
	#state: PublicAgentState;

	constructor(ctx: Acode.PluginContext | null) {
		this.credentials = new PortableCredentialStore(ctx);
		this.providers = new ProviderRegistry(this.credentials, () => this.settings.value.customModels);
		this.#sessionStore = createSessionStore(ctx);
		this.#state = {
			status: "booting",
			messages: [],
			activities: [],
			queued: [],
			compacting: false,
			models: [],
			settings: this.settings.value,
			usage: { tokens: 0, cost: 0 },
			contextTokens: 0,
			chats: [],
			commands: BUILT_IN_SLASH_COMMANDS,
		};
		this.settings.subscribe((settings) => {
			this.#state.settings = settings;
			void this.#activeSession()?.applySettings(settings);
			this.#emit();
		});
		this.#hostUnsubscribers = [
			subscribeToSidebarFolders(() => {
				void this.#syncWorkspaces().catch((error) => {
					console.warn("AI workspace list could not be refreshed", error);
				});
			}),
			subscribeToSourceFiles(),
		];
	}

	get state(): PublicAgentState {
		return {
			...this.#state,
			messages: [...this.#state.messages],
			activities: [...this.#state.activities],
			queued: [...this.#state.queued],
			models: [...this.#state.models],
			commands: [...this.#state.commands],
			settings: { ...this.#state.settings },
		};
	}

	get workspaces(): WorkspaceInfo[] {
		return getAvailableWorkspaces();
	}

	async searchFiles(query: string): Promise<MentionFile[]> {
		const workspace = this.#activeSession()?.workspace;
		if (!workspace) return [];
		try {
			return await searchWorkspaceFiles(workspace, query);
		} catch (error) {
			console.warn("AI file mention search failed", error);
			return [];
		}
	}

	async openWorkspaceFile(path: string): Promise<void> {
		const workspace = this.#activeSession()?.workspace;
		if (!workspace) throw new Error("Open a project folder first.");
		const { uri } = workspace.sandbox.resolve(path);
		await openAcodeUri(uri);
	}

	async initialize(): Promise<void> {
		await this.#sessionStore.hydrate();
		const workspaces = this.workspaces;
		const selected = workspaces.find((workspace) => workspace.id === this.settings.value.activeWorkspaceId)
			?? workspaces[0];
		if (selected) await this.selectWorkspace(selected.id);
		else {
			this.#state = { ...this.#state, status: "ready", models: this.providers.getModels(this.settings.value.providerId), chats: this.#summaries() };
			this.#emit();
		}
		void this.#refreshProviderModel(this.settings.value.providerId, this.settings.value.modelId);
	}

	async send(text: string, mode: "steer" | "followUp" = "steer", images?: ImageContent[]): Promise<void> {
		const prompt = text.trim();
		const session = this.#activeSession();
		if (!session) throw new Error("Open a project folder before starting the agent.");
		const attached = await collectPromptImages(prompt, images ?? [], session.workspace, this.settings.value.imageAutoResize);
		if (this.settings.value.blockImages && attached.length) throw new Error("Images are blocked in Pi settings.");
		if (!prompt && !attached.length) return;
		const auth = await this.providers.models.checkAuth(this.settings.value.providerId);
		if (!auth) throw new Error(`Add a ${this.settings.value.providerId} credential before sending a message.`);
		try {
			await session.prompt(prompt, mode, attached);
		} catch (error) {
			this.#state.error = error instanceof Error ? error.message : String(error);
			this.#state.status = "error";
			this.#emit();
			throw error;
		}
	}

	async addGlobalSkillRoot(): Promise<{ skills: string[]; prompts: string[]; roots: string[] } | undefined> {
		const picked = await pickGlobalSkillsFolder();
		if (!picked) return undefined;
		const roots = [...new Set([...this.settings.value.globalSkillRoots, picked.uri])];
		this.settings.update({ globalSkillRoots: roots });
		return this.#activeSession()?.reloadResources();
	}

	async removeGlobalSkillRoot(uri: string): Promise<void> {
		this.settings.update({ globalSkillRoots: this.settings.value.globalSkillRoots.filter((root) => root !== uri) });
		await this.#activeSession()?.reloadResources();
	}

	async executeSlashCommand(name: string, args: string): Promise<SlashCommandExecution> {
		const session = this.#activeSession();
		if (!session) throw new Error("Open a project folder before running a command.");
		const command = session.snapshot.commands.find((item) => item.name.toLowerCase() === name.toLowerCase());
		if (!command) throw new Error(`Unknown command: /${name}`);
		if (command.source !== "action") {
			await this.#requireProviderAuth();
			await session.invokeResource(command.name, args);
			return {};
		}
			switch (command.name) {
			case "model":
			case "scoped-models": return { action: "models" };
			case "settings": return { action: "pi-settings" };
			case "login":
			case "logout": return { action: "settings" };
			case "resume": return { action: "sessions" };
			case "new":
				await this.newConversation();
				return {};
			case "compact":
				await session.compact(args);
				return {};
			case "name":
				await session.rename(args);
				this.#emit();
				return {};
			case "session": {
				const info = session.sessionInfo();
				return { panel: {
					title: "Session details",
					description: info.title,
					rows: [
						{ label: "Session ID", value: info.id },
						{ label: "Tokens", value: formatTokens(info.tokens) },
						{ label: "Cost", value: info.cost > 0 ? `$${info.cost.toFixed(4)}` : "—" },
						{ label: "Provider", value: this.settings.value.providerId },
						{ label: "Model", value: session.model?.name ?? this.settings.value.modelId },
					],
				} };
			}
			case "tree": return { action: "tree" };
			case "fork": return { action: "fork" };
			case "clone":
				await this.forkConversation();
				return {};
			case "copy": {
				const copyText = session.latestAssistantText();
				if (!copyText) throw new Error("There is no assistant response to copy yet.");
				return { copyText, message: "Response copied." };
			}
			case "reload": {
				const loaded = await session.reloadResources();
				return { panel: resourcePanel(loaded) };
			}
			case "export": {
				const body = await session.exportJson();
				return { panel: { title: "Export session", description: "Portable JSON export", body, copyText: body } };
			}
			case "import":
				await this.importConversation();
				return {};
			case "hotkeys": return { panel: hotkeysPanel() };
			default: throw new Error(`Command /${command.name} is not available in Acode.`);
		}
	}

	async getTreeItems(): Promise<SessionTreeItem[]> {
		return this.#activeSession()?.treeItems() ?? [];
	}

	async navigateTree(targetId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<string | undefined> {
		return this.#activeSession()?.navigateTree(targetId, options);
	}

	async forkConversation(targetId?: string): Promise<string | undefined> {
		const session = this.#activeSession();
		const workspace = this.#state.workspace;
		if (!session || !workspace) throw new Error("Open a session before forking it.");
		let entries = await session.branchEntries(targetId);
		if (!entries.length && !targetId) throw new Error("There is no session branch to clone.");
		let restoredText: string | undefined;
		if (targetId) {
			const selected = entries.at(-1);
			if (!selected || selected.id !== targetId || selected.type !== "message" || selected.message.role !== "user") {
				throw new Error("Forks must start from a user message.");
			}
			restoredText = messagePlainText(selected.message);
			entries = entries.slice(0, -1);
		}
		const id = createChatId();
		await this.#sessionStore.seed({
			id,
			title: `${session.title} (${targetId ? "fork" : "clone"})`,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			providerId: session.model?.provider ?? this.settings.value.providerId,
			modelId: session.model?.id ?? this.settings.value.modelId,
			entries,
		});
		await this.#openChat(id, workspace);
		return restoredText;
	}

	async importConversation(): Promise<void> {
		const workspace = this.#state.workspace;
		if (!workspace) throw new Error("Open a project folder before importing a session.");
		const browser = acode.require("fileBrowser") as FileBrowser | undefined;
		if (typeof browser !== "function") throw new Error("Acode's file picker is unavailable.");
		let picked: SelectedFile;
		try {
			picked = await browser("file", "Choose a Pi JSON or JSONL session", true);
		} catch (error) {
			if (/cancel|abort/i.test(error instanceof Error ? error.message : String(error))) return;
			throw error;
		}
		const text = await acode.fsOperation(picked.url).readFile("utf-8");
		const imported = parseImportedSession(text);
		const id = createChatId();
		await this.#sessionStore.seed({
			id,
			title: imported.name || picked.name.replace(/\.(?:jsonl?|txt)$/i, "") || "Imported session",
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			providerId: this.settings.value.providerId,
			modelId: this.settings.value.modelId,
			entries: imported.entries,
		});
		await this.#openChat(id, workspace);
	}

	async abort(): Promise<RestoredPrompt[]> {
		return await this.#activeSession()?.abort() ?? [];
	}

	async newConversation(): Promise<void> {
		if (!this.#state.workspace) throw new Error("Open a project folder before starting the agent.");
		await this.#openChat(createChatId(), this.#state.workspace);
	}

	async selectChat(chatId: string): Promise<void> {
		await this.#sessionStore.hydrate();
		const meta = this.#sessionStore.list().find((item) => item.id === chatId);
		const workspaceId = this.#sessions.get(chatId)?.workspace.info.id ?? meta?.workspaceId ?? this.#state.workspace?.id;
		if (!workspaceId) throw new Error("That chat is no longer available.");
		const info = this.workspaces.find((workspace) => workspace.id === workspaceId);
		if (!info) throw new Error("Open the workspace for this chat first.");
		await this.#openChat(chatId, info);
	}

	async deleteChat(chatId: string): Promise<void> {
		await this.#sessionStore.hydrate();
		const session = this.#sessions.get(chatId);
		this.#sessionListeners.get(chatId)?.();
		this.#sessionListeners.delete(chatId);
		this.#sessions.delete(chatId);
		await session?.dispose();
		await this.#sessionStore.remove(chatId);
		if (this.#activeId === chatId) {
			this.#activeId = undefined;
			const next = this.#sessionStore.list()[0];
			if (next) await this.selectChat(next.id);
			else if (this.#state.workspace) await this.newConversation();
			else this.#emit();
			return;
		}
		this.#emit();
	}

	setPermissionMode(mode: PermissionMode): void {
		this.settings.update({ permissionMode: mode });
		this.#emit();
	}

	async selectWorkspace(workspaceIdOrUri: string): Promise<void> {
		await this.#sessionStore.hydrate();
		const info = this.workspaces.find((workspace) => workspace.id === workspaceIdOrUri || workspace.rootUri === workspaceIdOrUri);
		if (!info) throw new Error("The selected Acode workspace is no longer open.");
		this.settings.update({ activeWorkspaceId: info.id });
		const existing = this.#sessionStore.list().find((item) => item.workspaceId === info.id);
		await this.#openChat(existing?.id ?? createChatId(), info);
	}

	async selectProvider(providerId: ProviderId): Promise<void> {
		const models = this.providers.getModels(providerId);
		if (!models.length) throw new Error(`No ${providerId} models are bundled.`);
		const currentModel = providerId === this.settings.value.providerId
			? models.find((model) => model.id === this.settings.value.modelId)
			: undefined;
		const model = currentModel ?? preferredModel(providerId, models);
		const thinkingLevel = clampThinkingLevel(model, this.settings.value.thinkingLevel);
		this.settings.update({ providerId, modelId: model.id, thinkingLevel });
		this.#state.models = models;
		void this.#activeSession()?.setModel(model);
		void this.#activeSession()?.setThinkingLevel(thinkingLevel);
		this.#state.model = model;
		this.#emit();
		void this.#refreshProviderModel(providerId, model.id);
	}

	selectModel(modelId: string): void {
		const model = this.providers.resolveModel(this.settings.value.providerId, modelId);
		const thinkingLevel = clampThinkingLevel(model, this.settings.value.thinkingLevel);
		this.settings.update({ modelId: model.id, thinkingLevel });
		void this.#activeSession()?.setModel(model);
		void this.#activeSession()?.setThinkingLevel(thinkingLevel);
		this.#state.model = model;
		this.#refreshModels();
		void this.#refreshProviderModel(this.settings.value.providerId, model.id);
	}

	addCustomModel(modelId: string): void {
		const id = sanitizeModelId(modelId);
		if (!id) throw new Error("Enter a model id like anthropic/claude-sonnet-4.6");
		const providerId = this.settings.value.providerId;
		const existing = this.settings.value.customModels[providerId] ?? [];
		const inCatalog = Boolean(this.providers.models.getModel(providerId, id));
		this.settings.update({
			modelId: id,
			customModels: inCatalog
				? this.settings.value.customModels
				: { ...this.settings.value.customModels, [providerId]: [...new Set([id, ...existing])] },
		});
		const model = this.providers.resolveModel(providerId, id);
		void this.#activeSession()?.setModel(model);
		this.#state.model = model;
		this.#refreshModels();
		void this.#refreshProviderModel(providerId, model.id);
	}

	removeCustomModel(modelId: string): void {
		const providerId = this.settings.value.providerId;
		const remaining = (this.settings.value.customModels[providerId] ?? []).filter((id) => id !== modelId);
		const customModels = { ...this.settings.value.customModels };
		if (remaining.length) customModels[providerId] = remaining;
		else delete customModels[providerId];
		const nextId = this.settings.value.modelId === modelId
			? remaining[0] ?? this.providers.getModels(providerId).find((model) => model.id !== modelId)?.id
			: this.settings.value.modelId;
		this.settings.update({ customModels, ...(nextId ? { modelId: nextId } : {}) });
		if (nextId) this.selectModel(nextId);
		else this.#refreshModels();
	}

	setThinkingLevel(level: AgentSettings["thinkingLevel"]): void {
		this.settings.update({ thinkingLevel: level });
		void this.#activeSession()?.setThinkingLevel(level);
	}

	async saveApiKey(providerId: ProviderId, key: string): Promise<void> {
		await this.credentials.setApiKey(providerId, key);
		if (this.settings.value.providerId === providerId) {
			await this.#refreshProviderModel(providerId, this.settings.value.modelId);
		}
		this.#state.error = undefined;
		this.#emit();
	}

	async loginSubscription(providerId: ProviderId): Promise<void> {
		this.#authAbort?.abort();
		const abort = new AbortController();
		this.#authAbort = abort;
		this.#state.authFlow = { providerId, status: "waiting", message: "Requesting a secure device code…" };
		this.#emit();
		try {
			await this.providers.models.login(providerId, "oauth", {
				signal: abort.signal,
				prompt: async () => {
					throw new Error("This portable sign-in flow does not accept secrets inside Acode.");
				},
				notify: (event) => {
					if (this.#authAbort === abort) this.#onAuthEvent(providerId, event);
				},
			});
			if (abort.signal.aborted) return;
			this.#state.authFlow = { providerId, status: "connected", message: "Subscription connected securely." };
			this.#state.error = undefined;
			await this.selectProvider(providerId);
			this.#emit();
		} catch (error) {
			if (abort.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
			const message = error instanceof Error ? error.message : String(error);
			this.#state.authFlow = { providerId, status: "error", message };
			this.#emit();
			throw error;
		} finally {
			if (this.#authAbort === abort) this.#authAbort = undefined;
		}
	}

	cancelSubscriptionLogin(): void {
		this.#authAbort?.abort();
		this.#authAbort = undefined;
		if (this.#state.authFlow?.status === "waiting") this.#state.authFlow = undefined;
		this.#emit();
	}

	async openSignIn(): Promise<void> {
		const url = this.#state.authFlow?.verificationUri;
		if (!url) throw new Error("No sign-in page is ready yet.");
		await openAuthTab(url);
	}

	async removeCredential(providerId: ProviderId): Promise<void> {
		if (this.#state.authFlow?.providerId === providerId) this.cancelSubscriptionLogin();
		await this.providers.models.logout(providerId);
		this.#state.authFlow = undefined;
		this.#emit();
	}

	async hasCredential(providerId: ProviderId): Promise<boolean> {
		return Boolean(await this.credentials.read(providerId));
	}

	async #requireProviderAuth(): Promise<void> {
		const providerId = this.settings.value.providerId;
		if (!(await this.providers.models.checkAuth(providerId))) {
			throw new Error(`Add a ${providerId} credential before running this command.`);
		}
	}

	approve(decision: MutationDecision): void {
		this.#activeSession()?.mutationGate.resolve(decision);
	}

	registerTool(tool: AgentTool): () => void {
		const unregister = this.extensions.registerTool(tool);
		void this.#activeSession()?.refreshTools();
		return () => {
			unregister();
			void this.#activeSession()?.refreshTools();
		};
	}

	registerProvider(provider: Provider): () => void {
		return this.providers.register(provider);
	}

	registerContext(id: string, source: ContextContribution): () => void {
		return this.extensions.registerContext(id, source);
	}

	registerFeature(feature: AgentFeature): () => void {
		return this.extensions.registerFeature(feature);
	}

	async dispose(): Promise<void> {
		this.#authAbort?.abort();
		for (const unsubscribe of this.#hostUnsubscribers.splice(0)) unsubscribe();
		await this.#disposeAllSessions();
		this.changes.clear();
	}

	#onAuthEvent(providerId: ProviderId, event: AuthEvent): void {
		if (event.type === "device_code") {
			this.#state.authFlow = {
				providerId,
				status: "waiting",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				message: "Open the provider page and enter this one-time code. Acode never sees your password.",
			};
			this.#emit();
			void openAuthTab(event.verificationUri).catch((error) => {
				if (this.#state.authFlow?.providerId !== providerId) return;
				this.#state.authFlow = {
					...this.#state.authFlow,
					message: error instanceof Error ? error.message : String(error),
				};
				this.#emit();
			});
			return;
		}
		if (event.type === "auth_url") {
			this.#state.authFlow = {
				providerId,
				status: "waiting",
				verificationUri: event.url,
				message: event.instructions ?? "Complete sign-in in your browser.",
			};
			this.#emit();
			void openAuthTab(event.url).catch((error) => {
				if (this.#state.authFlow?.providerId !== providerId) return;
				this.#state.authFlow = {
					...this.#state.authFlow,
					message: error instanceof Error ? error.message : String(error),
				};
				this.#emit();
			});
			return;
		}
		const message = event.type === "progress" ? event.message : event.message;
		this.#state.authFlow = { providerId, status: "waiting", message };
		this.#emit();
	}

	#refreshModels(): void {
		this.#state.models = this.providers.getModels(this.settings.value.providerId);
		this.#emit();
	}

	async #refreshProviderModel(providerId: ProviderId, modelId: string): Promise<void> {
		let model: Model<any>;
		try {
			model = await this.providers.refreshModel(providerId, modelId);
		} catch (error) {
			console.warn(`${providerId} model metadata could not be refreshed`, error);
			return;
		}
		if (this.settings.value.providerId !== providerId || this.settings.value.modelId !== modelId) return;
		const thinkingLevel = clampThinkingLevel(model, this.settings.value.thinkingLevel);
		if (thinkingLevel !== this.settings.value.thinkingLevel) this.settings.update({ thinkingLevel });
		await this.#activeSession()?.setModel(model);
		await this.#activeSession()?.setThinkingLevel(thinkingLevel);
		this.#state.model = model;
		this.#refreshModels();
	}

	#emit(): void {
		this.#state.settings = this.settings.value;
		this.#state.chats = this.#summaries();
		this.#state.activeChatId = this.#activeId;
		this.changes.emit(this.state);
	}

	#activeSession(): AgentSession | undefined {
		return this.#activeId ? this.#sessions.get(this.#activeId) : undefined;
	}

	#summaries(): ChatSummary[] {
		const stored = this.#sessionStore.list();
		const seen = new Set(stored.map((item) => item.id));
		const extras = [...this.#sessions.values()]
			.filter((session) => !seen.has(session.id))
			.map((session) => ({
				id: session.id,
				title: session.title,
				workspaceId: session.workspace.info.id,
				workspaceName: session.workspace.info.name,
				updatedAt: Date.now(),
				running: session.snapshot.isRunning,
			}));
		return [
			...stored.map((item) => ({
				...item,
				workspaceName: this.#sessions.get(item.id)?.workspace.info.name || item.workspaceName || this.workspaces.find((workspace) => workspace.id === item.workspaceId)?.name || "",
				running: this.#sessions.get(item.id)?.snapshot.isRunning ?? false,
			})),
			...extras,
		];
	}

	async #openChat(chatId: string, info: WorkspaceInfo): Promise<void> {
		this.#unbindUi();
		this.settings.update({ activeWorkspaceId: info.id, activeChatId: chatId });
		let session = this.#sessions.get(chatId);
		if (!session) {
			const stored = this.#sessionStore.load(chatId);
			session = new AgentSession({
				id: chatId,
				title: stored?.title,
				workspace: new AcodeWorkspace(info.rootUri, info.name),
				providers: this.providers,
				extensions: this.extensions,
				settings: () => this.settings.value,
				store: this.#sessionStore,
				mutationGate: new MutationGate(),
			});
			this.#sessions.set(chatId, session);
			this.#sessionListeners.set(chatId, session.changes.subscribe(() => {
				if (this.#activeId === chatId) this.#applyActiveSnapshot();
				else this.#emit();
			}));
			try {
				await session.initialize();
			} catch (error) {
				this.#sessionListeners.get(chatId)?.();
				this.#sessionListeners.delete(chatId);
				this.#sessions.delete(chatId);
				throw error;
			}
		}
		this.#activeId = chatId;
		this.#uiUnsubscribers = [
			session.mutationGate.changes.subscribe((approval) => {
				if (this.#activeId === chatId) {
					this.#state.approval = approval;
					this.#emit();
				}
			}),
		];
		this.#state.workspace = info;
		this.#state.approval = session.mutationGate.pending;
		this.#state.models = this.providers.getModels(this.settings.value.providerId);
		this.#applyActiveSnapshot();
	}

	#applyActiveSnapshot(): void {
		const session = this.#activeSession();
		const snapshot = session?.snapshot;
		this.#state = {
			...this.#state,
			status: snapshot?.error ? "error" : snapshot?.isRunning ? "running" : "ready",
			messages: snapshot?.messages ?? [],
			streamingMessage: snapshot?.streamingMessage,
			activities: snapshot?.activities ?? [],
			queued: snapshot?.queued ?? [],
			compacting: snapshot?.compacting ?? false,
			error: snapshot?.error,
			usage: snapshot?.usage ?? { tokens: 0, cost: 0 },
			contextTokens: snapshot?.contextTokens ?? 0,
			commands: snapshot?.commands ?? BUILT_IN_SLASH_COMMANDS,
			model: session?.model ?? this.#state.model,
			workspace: session?.workspace.info ?? this.#state.workspace,
		};
		this.#emit();
	}

	#unbindUi(): void {
		for (const unsubscribe of this.#uiUnsubscribers.splice(0)) unsubscribe();
	}

	async #syncWorkspaces(): Promise<void> {
		const workspaces = this.workspaces;
		const currentId = this.#state.workspace?.id;
		if (currentId && !workspaces.some((workspace) => workspace.id === currentId)) {
			if (workspaces[0]) await this.selectWorkspace(workspaces[0].id);
			else {
				this.#unbindUi();
				this.#state = { ...this.#state, workspace: undefined, status: "ready" };
				this.#emit();
			}
			return;
		}
		if (!currentId && workspaces[0]) {
			await this.selectWorkspace(workspaces[0].id);
			return;
		}
		this.#emit();
	}

	async #disposeAllSessions(): Promise<void> {
		this.#unbindUi();
		for (const unsubscribe of this.#sessionListeners.values()) unsubscribe();
		this.#sessionListeners.clear();
		await Promise.all([...this.#sessions.values()].map((session) => session.dispose()));
		this.#sessions.clear();
		this.#activeId = undefined;
	}
}

export type SlashCommandExecution = {
	action?: "models" | "settings" | "pi-settings" | "sessions" | "tree" | "fork";
	message?: string;
	copyText?: string;
	panel?: CommandPanelData;
};

export type CommandPanelData = {
	title: string;
	description?: string;
	rows?: Array<{ label: string; value: string }>;
	body?: string;
	copyText?: string;
	markdown?: boolean;
};

function preferredModel(providerId: ProviderId, models: Model<any>[]): Model<any> {
	const preferred: Partial<Record<ProviderId, string[]>> = {
		openrouter: ["nvidia/nemotron-3.5-lightning:free", "auto"],
		openai: ["gpt-5-mini", "gpt-4.1-mini"],
		"openai-codex": ["gpt-5.6-terra", "gpt-5.4-mini", "gpt-5.4"],
		anthropic: ["claude-haiku-4-5", "claude-sonnet-4-5"],
		google: ["gemini-2.5-flash", "gemini-2.0-flash"],
		xai: ["grok-4.6", "grok-4.5", "grok-4.3"],
		groq: ["openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
	};
	for (const id of preferred[providerId] ?? []) {
		const match = models.find((model) => model.id === id);
		if (match) return match;
	}
	return models[0]!;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens` : `${tokens} tokens`;
}

function resourcePanel(loaded: { skills: string[]; prompts: string[]; roots: string[] }): CommandPanelData {
	const parts = [
		loaded.skills.length ? `Skills\n${loaded.skills.map((name) => `• /skill:${name}`).join("\n")}` : "Skills\nNone found",
		loaded.prompts.length ? `Prompts\n${loaded.prompts.map((name) => `• /${name}`).join("\n")}` : "Prompts\nNone found",
	];
	return {
		title: "Pi resources",
		description: `${loaded.skills.length} skills · ${loaded.prompts.length} prompts`,
		body: parts.join("\n\n"),
		rows: loaded.roots.length ? [{ label: "Global roots", value: `${loaded.roots.length} scanned` }] : undefined,
	};
}

function hotkeysPanel(): CommandPanelData {
	return {
		title: "Composer shortcuts",
		description: "Keyboard controls available in Acode",
		rows: [
			{ label: "Send / steer", value: "Ctrl/⌘ + Enter" },
			{ label: "Queue follow-up", value: "Ctrl/⌘ + Shift + Enter" },
			{ label: "Commands", value: "Type /" },
			{ label: "Files", value: "Type @" },
			{ label: "Navigate picker", value: "↑ / ↓" },
			{ label: "Choose item", value: "Enter / Tab" },
			{ label: "Close picker", value: "Escape" },
		],
	};
}

function parseImportedSession(text: string): { name?: string; entries: SessionTreeEntry[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
	}
	const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	const candidates = Array.isArray(parsed) ? parsed : Array.isArray(object?.entries) ? object.entries : [];
	const entries = candidates.filter((entry): entry is SessionTreeEntry => Boolean(entry && typeof entry === "object" && "id" in entry && "type" in entry));
	if (!entries.length) throw new Error("That file does not contain a Pi session tree.");
	return { name: typeof object?.name === "string" ? object.name : undefined, entries };
}
