import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AuthEvent, Model, Provider } from "@earendil-works/pi-ai";
import { Signal } from "../core/events";
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
	WorkspaceInfo,
} from "../core/types";
import { MutationGate } from "../permissions/mutationGate";
import { openAuthTab } from "../platform/authTab";
import { PortableCredentialStore } from "../platform/credentials";
import { createSessionStore, type SessionStore } from "../platform/sessionStore";
import { createChatId } from "../session/sessionText";
import { ProviderRegistry } from "../providers/providerRegistry";
import { AgentSession } from "../session/agentSession";
import { sanitizeModelId } from "../providers/customModels";
import { clampThinkingLevel } from "../providers/thinkingLevels";
import { AcodeWorkspace } from "../workspace/acodeWorkspace";
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
		};
		this.settings.subscribe((settings) => {
			this.#state.settings = settings;
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
			settings: { ...this.#state.settings },
		};
	}

	get workspaces(): WorkspaceInfo[] {
		return getAvailableWorkspaces();
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
	}

	async send(text: string, mode: "steer" | "followUp" = "steer"): Promise<void> {
		const prompt = text.trim();
		if (!prompt) return;
		if (!this.#activeSession()) throw new Error("Open a project folder before starting the agent.");
		const auth = await this.providers.models.checkAuth(this.settings.value.providerId);
		if (!auth) throw new Error(`Add a ${this.settings.value.providerId} credential before sending a message.`);
		try {
			await this.#activeSession()?.prompt(prompt, mode);
		} catch (error) {
			this.#state.error = error instanceof Error ? error.message : String(error);
			this.#state.status = "error";
			this.#emit();
			throw error;
		}
	}

	async abort(): Promise<string[]> {
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
	}

	selectModel(modelId: string): void {
		const model = this.providers.resolveModel(this.settings.value.providerId, modelId);
		const thinkingLevel = clampThinkingLevel(model, this.settings.value.thinkingLevel);
		this.settings.update({ modelId: model.id, thinkingLevel });
		void this.#activeSession()?.setModel(model);
		void this.#activeSession()?.setThinkingLevel(thinkingLevel);
		this.#state.model = model;
		this.#refreshModels();
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
