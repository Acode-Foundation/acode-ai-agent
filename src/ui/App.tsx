import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, Ellipsis, Folder, Plus, Trash2, X } from "lucide-preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import { PERMISSION_MODES } from "../core/schema";
import type { ChatSummary, MutationDecision, MutationRequest, ProviderId, PublicAgentState, WorkspaceInfo } from "../core/types";
import { PROVIDERS } from "../providers/providerRegistry";
import { thinkingLevelsFor } from "../providers/thinkingLevels";
import { backActionId, useBackAction } from "./actionStack";
import { Collapse } from "./Collapse";
import { Composer, UserMessage, type ComposerHandle } from "./Composer";
import { CopyButton } from "./CopyButton";
import { fadeInUp, fadeSlide, playMotion } from "./motion";
import { Markdown } from "./markdown";
import { Sheet } from "./Sheet";
import { buildTurns } from "./transcript";
import { useChatScroll } from "./useChatScroll";
import { WorkingIndicator, WorkLog } from "./WorkLog";
import { previewImageInAcode } from "../platform/deviceImage";
import { modelAcceptsImages } from "../platform/promptImages";
import type { ComposerDraft } from "./composerDraft";

type Props = { controller: AgentController };

export function App({ controller }: Props) {
	const [state, setState] = useState<PublicAgentState>(controller.state);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [configOpen, setConfigOpen] = useState(false);
	const [chatsOpen, setChatsOpen] = useState(false);
	const [toast, setToast] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const composerRef = useRef<ComposerHandle>(null);

	useEffect(() => controller.changes.subscribe(setState), [controller]);
	const running = state.status === "running";
	const followKey = `${state.activeChatId}:${state.messages.length}:${running ? "run" : "idle"}:${state.queued.length}:${state.compacting ? "c" : ""}:${state.activities.length}:${state.activities.at(-1)?.status ?? ""}:${state.approval?.id ?? ""}`;
	const { showLatest, jumpToLatest, pin, captureThread } = useChatScroll(scrollRef, followKey);

	const turns = useMemo(
		() => buildTurns(state.messages, running ? state.streamingMessage : undefined, state.activities, running),
		[state.messages, state.streamingMessage, state.activities, running],
	);

	const send = useCallback(async (draft: ComposerDraft, mode: "steer" | "followUp" = "steer") => {
		if (!draft.text.trim() && !draft.images.length) return;
		pin();
		try {
			await controller.send(draft.text, mode, draft.images);
		} catch (error) {
			composerRef.current?.restore(draft);
			setToast(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}, [controller, pin]);

	const stop = useCallback(async () => {
		const restored = await controller.abort();
		if (!restored.length) return;
		composerRef.current?.restore({
			text: restored.map((item) => item.text).filter(Boolean).join("\n"),
			images: restored.flatMap((item, index) => item.images.map((image) => ({
				...image,
				id: `${index}-${image.mimeType}-${image.data.length}`,
				name: "image",
			}))),
		});
	}, [controller]);

	return (
		<div class="agent-shell">
			<header class="agent-header">
				<button class="chat-trigger" type="button" onClick={() => setChatsOpen(true)}>
					<span>{state.chats.find((chat) => chat.id === state.activeChatId)?.title ?? "New chat"}</span>
					{state.chats.some((chat) => chat.running && chat.id !== state.activeChatId) && <i class="bg-run" />}
				</button>
				<button class="icon-button" type="button" onClick={() => void controller.newConversation().catch((error) => setToast(String(error)))} aria-label="New chat"><Plus size={18} strokeWidth={2} /></button>
				<button class="icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Ellipsis size={18} strokeWidth={2} /></button>
			</header>

			<main class="conversation" ref={scrollRef}>
				{turns.length === 0 ? (
					<EmptyState
						hasWorkspace={Boolean(state.workspace)}
						onPrompt={(value) => composerRef.current?.setText(value)}
						onSettings={() => setSettingsOpen(true)}
					/>
				) : (
					<div class="thread">
						{turns.map((turn) => (
							<section class="turn" key={turn.id}>
								{(turn.userParts?.length || turn.user) && (
									<UserMessage
										parts={turn.userParts}
										text={turn.user}
										onOpenFile={(path) => void controller.openWorkspaceFile(path).catch((error) => setToast(error instanceof Error ? error.message : String(error)))}
										onPreviewImage={(image) => {
											void previewImageInAcode({ ...image, name: image.name || "image" }).catch((error) => {
												setToast(error instanceof Error ? error.message : String(error));
											});
										}}
									/>
								)}
								{turn.notice && (
									<CompactNotice kind={turn.notice.kind} text={turn.notice.text} workspace={state.workspace} />
								)}
								<WorkLog turn={turn} workspace={state.workspace} />
								{turn.answer && (
									<article class={`bubble assistant${turn.streaming ? " streaming" : ""}`}>
										<Markdown text={turn.answer} workspace={state.workspace} />
										{!turn.streaming && (
											<div class="bubble-actions">
												<CopyButton getText={() => turn.answer ?? ""} label="Copy response" />
											</div>
										)}
									</article>
								)}
								{turn.streaming && <WorkingIndicator startedAt={turn.startedAt} />}
							</section>
						))}
						{state.compacting && <div class="compact-status">Compacting earlier turns…</div>}
						{running && !state.compacting && !turns.some((turn) => turn.streaming) && <WorkingIndicator />}
					</div>
				)}
				{state.error && <div class="inline-error">{state.error}</div>}
				<JumpLatest visible={showLatest} onJump={jumpToLatest} />
			</main>

			{state.approval && (
				<ApprovalPanel approval={state.approval} onApprove={(decision) => controller.approve(decision)} />
			)}

			<Composer
				ref={composerRef}
				controller={controller}
				running={running}
				disabled={!state.workspace}
				permissionMode={state.settings.permissionMode}
				effort={state.settings.thinkingLevel}
				effortLevels={thinkingLevelsFor(state.model)}
				modelName={state.model?.name ?? "Model"}
				acceptsImages={modelAcceptsImages(state.model)}
				onOpenConfig={() => setConfigOpen(true)}
				usage={state.usage}
				contextTokens={state.contextTokens}
				contextWindow={state.model?.contextWindow}
				queued={state.queued}
				onFocusComposer={captureThread}
				onSubmit={send}
				onStop={() => void stop()}
				onToast={setToast}
			/>

			{chatsOpen && <ChatSheet controller={controller} state={state} onClose={() => setChatsOpen(false)} onError={setToast} />}
			{settingsOpen && <SettingsSheet controller={controller} state={state} onClose={() => setSettingsOpen(false)} onToast={setToast} />}
			{configOpen && <ConfigSheet controller={controller} state={state} onClose={() => setConfigOpen(false)} />}
			{toast && <Toast message={toast} onDone={() => setToast("")} />}
		</div>
	);
}

function ChatSheet({ controller, state, onClose, onError }: { controller: AgentController; state: PublicAgentState; onClose: () => void; onError: (message: string) => void }) {
	const workspaces = controller.workspaces;
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [filter, setFilter] = useState<string>(state.workspace?.id ?? "all");
	const showFilters = workspaces.length > 0 || state.chats.length > 0;
	const chats = useMemo(
		() => filter === "all" ? state.chats : state.chats.filter((chat) => chat.workspaceId === filter),
		[state.chats, filter],
	);
	const groups = useMemo(() => groupChatsByRecency(chats), [chats]);
	const fail = (error: unknown) => onError(error instanceof Error ? error.message : String(error));
	const startNew = (close: () => void) => {
		const create = () => controller.newConversation().then(close).catch(fail);
		if (filter !== "all" && filter !== state.workspace?.id) {
			void controller.selectWorkspace(filter).then(create).catch(fail);
			return;
		}
		void create();
	};
	const projectName = (chat: ChatSummary) => workspaceLabel(chat, workspaces);
	return (
		<Sheet class="chats" onClose={onClose}>
			{(close) => (
				<>
					<div class="sheet-handle" />
					<header class="sheet-header chats-header">
						<h2>Sessions{chats.length > 0 && <small>{chats.length}</small>}</h2>
						<div class="sheet-header-actions">
							<button type="button" onClick={() => startNew(close)} aria-label="New session">
								<Plus size={16} strokeWidth={2} />
							</button>
							<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
						</div>
					</header>
					<div class="chats-body">
						{showFilters && (
							<div class="workspace-chips" role="tablist" aria-label="Filter sessions">
								<button
									type="button"
									role="tab"
									aria-selected={filter === "all"}
									class={filter === "all" ? "selected" : ""}
									onClick={() => {
										setConfirmId(null);
										setFilter("all");
									}}
								>
									<span>All</span>
								</button>
								{workspaces.map((workspace) => (
									<button
										type="button"
										role="tab"
										aria-selected={filter === workspace.id}
										class={filter === workspace.id ? "selected" : ""}
										key={workspace.id}
										onClick={() => {
											setConfirmId(null);
											setFilter(workspace.id);
										}}
									>
										<Folder size={13} strokeWidth={2} aria-hidden="true" />
										<span>{workspace.name}</span>
									</button>
								))}
							</div>
						)}
						{chats.length === 0 ? (
							<div class="chat-empty">
								<p>
									{!state.workspace
										? "Open a folder to start a session."
										: filter === "all"
											? "No sessions yet."
											: "No sessions in this folder yet."}
								</p>
								{state.workspace && (
									<button class="chat-empty-new" type="button" onClick={() => startNew(close)}>Start a session</button>
								)}
							</div>
						) : (
							<div class="chat-list">
								{groups.map((group) => (
									<section class="chat-group" key={group.id}>
										<h3>{group.label}</h3>
										{group.chats.map((chat) => (
											<div
												class={`chat-row${chat.id === state.activeChatId ? " selected" : ""}${chat.running ? " running" : ""}`}
												key={chat.id}
											>
												<button
													type="button"
													onClick={() => {
														setConfirmId(null);
														void controller.selectChat(chat.id).then(close).catch(fail);
													}}
												>
													<span class="chat-copy">
														<b>{chat.title}</b>
														<small>
															<span class="chat-project">{projectName(chat)}</span>
															<span class="chat-sep">·</span>
															{chat.running ? "Running" : formatChatTime(chat.updatedAt)}
															{chat.id === state.activeChatId ? " · current" : ""}
														</small>
													</span>
													{chat.running && <i class="run-dot" aria-hidden="true" />}
												</button>
												{confirmId === chat.id ? (
													<button type="button" class="chat-delete confirm" onClick={() => void controller.deleteChat(chat.id).then(() => setConfirmId(null)).catch(fail)}>
														Delete
													</button>
												) : (
													<button type="button" class="chat-delete" aria-label={`Delete ${chat.title}`} onClick={() => setConfirmId(chat.id)}>
														<Trash2 size={14} strokeWidth={2} />
													</button>
												)}
											</div>
										))}
									</section>
								))}
							</div>
						)}
					</div>
				</>
			)}
		</Sheet>
	);
}

function EmptyState({ hasWorkspace, onPrompt, onSettings }: { hasWorkspace: boolean; onPrompt: (value: string) => void; onSettings: () => void }) {
	const suggestions = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const buttons = suggestions.current?.querySelectorAll("button");
		if (!buttons?.length) return;
		buttons.forEach((button, index) => {
			void fadeInUp(button, index * 0.05);
		});
	}, [hasWorkspace]);
	return (
		<section class="empty-state">
			<h1>{hasWorkspace ? "What should we work on?" : "Open a folder first"}</h1>
			<p>
				{hasWorkspace
					? "The agent can read the workspace, search files, and propose edits."
					: "Add a project folder in the Acode sidebar so the agent has a sandbox."}
			</p>
			{hasWorkspace && (
				<div class="suggestions" ref={suggestions}>
					<button type="button" onClick={() => onPrompt("Map this project and explain how the main pieces fit together.")}>Map the project</button>
					<button type="button" onClick={() => onPrompt("Review the active file and fix the highest-impact issue.")}>Review the open file</button>
					<button type="button" onClick={onSettings}>Add a provider key</button>
				</div>
			)}
		</section>
	);
}

function SettingsSheet({ controller, state, onClose, onToast }: { controller: AgentController; state: PublicAgentState; onClose: () => void; onToast: (message: string) => void }) {
	const [providerId, setProviderId] = useState<ProviderId>(PROVIDERS.some((item) => item.id === state.settings.providerId) ? state.settings.providerId : PROVIDERS[0]!.id);
	const [key, setKey] = useState("");
	const [connected, setConnected] = useState(false);
	useEffect(() => { void controller.hasCredential(providerId).then(setConnected); }, [controller, providerId, state.authFlow?.status]);
	const provider = PROVIDERS.find((item) => item.id === providerId)!;
	const authFlow = state.authFlow?.providerId === providerId ? state.authFlow : undefined;
	return (
		<Sheet onClose={onClose}>
			{(close) => (
				<>
				<header class="sheet-header">
					<h2>Settings</h2>
					<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
				</header>

				<label class="field-label">Provider</label>
				<div class="provider-list">
					{PROVIDERS.map((item) => (
						<button class={providerId === item.id ? "selected" : ""} type="button" key={item.id} onClick={() => setProviderId(item.id)}>
							{item.name}
						</button>
					))}
				</div>

				<div class="credential">
					<p class={connected ? "ok" : ""}>{connected ? `${provider.name} is connected` : `Add a ${provider.name} credential`}</p>
					{provider.apiKey && (
						<>
							<div class="key-input">
								<input type="password" value={key} placeholder={connected ? "Replacement key" : provider.keyPlaceholder} onInput={(event) => setKey(event.currentTarget.value)} />
								<button type="button" disabled={!key.trim()} onClick={() => void controller.saveApiKey(providerId, key).then(async () => {
									setKey("");
									setConnected(await controller.hasCredential(providerId));
									await controller.selectProvider(providerId);
									onToast("Credential saved");
								}).catch((error) => onToast(String(error)))}>Save</button>
							</div>
							{provider.keyUrl && <a href={provider.keyUrl} target="_blank" rel="noreferrer">Get an API key</a>}
						</>
					)}
					{provider.subscriptionLabel && (
						<div class="subscription">
							<button type="button" disabled={authFlow?.status === "waiting"} onClick={() => void controller.loginSubscription(providerId).then(async () => {
								setConnected(await controller.hasCredential(providerId));
								onToast(`${provider.name} connected`);
							}).catch((error) => onToast(error instanceof Error ? error.message : String(error)))}>
								{authFlow?.status === "waiting" ? "Waiting…" : provider.subscriptionLabel}
							</button>
							{authFlow && (
								<div class={`device ${authFlow.status}`}>
									{authFlow.userCode && <code>{authFlow.userCode}</code>}
									<p>{authFlow.message}</p>
									{authFlow.verificationUri && (
										<button type="button" onClick={() => void controller.openSignIn().catch((error) => onToast(String(error)))}>
											Open sign-in
										</button>
									)}
									{authFlow.status === "waiting" && <button type="button" onClick={() => controller.cancelSubscriptionLogin()}>Cancel</button>}
								</div>
							)}
						</div>
					)}
					{connected && <button class="text-button" type="button" onClick={() => void controller.removeCredential(providerId).then(() => {
						setConnected(false);
						onToast(`${provider.name} removed`);
					}).catch((error) => onToast(String(error)))}>Disconnect</button>}
				</div>

				<label class="toggle">
					<span>Include current selection</span>
					<input type="checkbox" checked={state.settings.includeSelection} onChange={(event) => controller.settings.update({ includeSelection: event.currentTarget.checked })} />
				</label>
				</>
			)}
		</Sheet>
	);
}

function ConfigSheet({ controller, state, onClose }: { controller: AgentController; state: PublicAgentState; onClose: () => void }) {
	const [view, setView] = useState<"main" | "providers" | "models">("main");
	const [error, setError] = useState("");
	const bodyRef = useRef<HTMLDivElement>(null);
	const firstView = useRef(true);
	const provider = PROVIDERS.find((item) => item.id === state.settings.providerId);
	const modelId = state.model?.id ?? state.settings.modelId;
	const modelName = state.model?.name ?? "Choose model";
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		if (firstView.current) {
			firstView.current = false;
			return;
		}
		void fadeInUp(body);
	}, [view]);
	const go = (next: typeof view) => setView(next);
	useBackAction(backActionId("config-view"), () => go("main"), view !== "main");
	return (
		<Sheet class={`config${view === "main" ? "" : " picker"}`} onClose={onClose}>
			{(close) => (
				<>
					<div class="sheet-handle" />
					<div ref={bodyRef} class="sheet-view">
						{view === "providers" ? (
							<>
								<header class="sheet-header with-back">
									<button type="button" class="sheet-back" onClick={() => go("main")} aria-label="Back">
										<ChevronLeft size={20} strokeWidth={2} />
									</button>
									<h2>Provider</h2>
									<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
								</header>
								<div class="picker-body">
									<ProviderPicker
										state={state}
										error={error}
										onPick={(providerId) => {
											setError("");
											void controller.selectProvider(providerId).then(() => go("models")).catch((caught) => {
												setError(caught instanceof Error ? caught.message : String(caught));
											});
										}}
									/>
								</div>
							</>
						) : view === "models" ? (
							<>
								<header class="sheet-header with-back">
									<button type="button" class="sheet-back" onClick={() => go("main")} aria-label="Back">
										<ChevronLeft size={20} strokeWidth={2} />
									</button>
									<h2>Model</h2>
									<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
								</header>
								<div class="picker-body">
									<ModelPicker controller={controller} state={state} onPicked={close} />
								</div>
							</>
						) : (
							<>
								<header class="sheet-header">
									<h2>Session</h2>
									<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
								</header>
								<div class="config-row">
									<div>
										<b>Permission</b>
										<small>{PERMISSION_MODES.find((mode) => mode.id === state.settings.permissionMode)?.hint}</small>
									</div>
									<div class="config-pills">
										{PERMISSION_MODES.map((mode) => (
											<button type="button" class={state.settings.permissionMode === mode.id ? "selected mode" : ""} key={mode.id} onClick={() => controller.setPermissionMode(mode.id)}>
												{mode.label}
											</button>
										))}
									</div>
								</div>
								<div class="config-row">
									<div>
										<b>Effort</b>
										<small>{thinkingLevelsFor(state.model).length > 1 ? "Levels this model actually supports" : "This model does not expose effort controls"}</small>
									</div>
									<div class="config-pills">
										{thinkingLevelsFor(state.model).map((level) => (
											<button type="button" class={state.settings.thinkingLevel === level.id ? "selected effort" : ""} key={level.id} onClick={() => controller.setThinkingLevel(level.id)}>
												{level.label}
											</button>
										))}
									</div>
								</div>
								<button type="button" class="config-nav" onClick={() => go("providers")}>
									<div>
										<b>Provider</b>
										<small>{provider?.hint ?? "Choose a provider"}</small>
									</div>
									<span class="config-nav-value">{provider?.name ?? state.settings.providerId}</span>
									<ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
								</button>
								<button type="button" class="config-nav" onClick={() => go("models")}>
									<div>
										<b>Model</b>
										{modelName !== modelId && <small>{modelId}</small>}
									</div>
									<span class="config-nav-value">{modelName}</span>
									<ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
								</button>
							</>
						)}
					</div>
				</>
			)}
		</Sheet>
	);
}

function ProviderPicker({ state, error, onPick }: { state: PublicAgentState; error: string; onPick: (providerId: ProviderId) => void }) {
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return PROVIDERS.filter((provider) => !needle || `${provider.name} ${provider.id} ${provider.hint}`.toLowerCase().includes(needle));
	}, [query]);
	return (
		<>
			<input
				class="model-search"
				autoFocus
				type="search"
				value={query}
				placeholder={`Search ${PROVIDERS.length} providers`}
				onInput={(event) => setQuery(event.currentTarget.value)}
			/>
			{error && <p class="custom-model-error">{error}</p>}
			<div class="model-list">
				{filtered.map((provider) => (
					<div class={`model-row${state.settings.providerId === provider.id ? " selected" : ""}`} key={provider.id}>
						<button type="button" onClick={() => onPick(provider.id)}>
							<span>
								<b>{provider.name}</b>
								<code>{provider.hint}</code>
							</span>
							<small>{state.settings.providerId === provider.id ? <Check size={16} strokeWidth={2.2} aria-hidden="true" /> : null}</small>
						</button>
					</div>
				))}
				{filtered.length === 0 && <p class="custom-model-hint">No providers match that search.</p>}
			</div>
		</>
	);
}

function ModelPicker({ controller, state, onPicked }: { controller: AgentController; state: PublicAgentState; onPicked: () => void }) {
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const customIds = state.settings.customModels[state.settings.providerId] ?? [];
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return state.models.filter((model) => !needle || `${model.name} ${model.id}`.toLowerCase().includes(needle));
	}, [query, state.models]);
	const addCustom = () => {
		try {
			controller.addCustomModel(query);
			setQuery("");
			setError("");
			onPicked();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};
	return (
		<>
			<div class="custom-model">
				<input
					class="model-search"
					autoFocus
					type="search"
					value={query}
					placeholder={state.settings.providerId === "openrouter" ? "Search or paste anthropic/claude-sonnet-4.6" : `Search ${state.models.length} models or paste an id`}
					onInput={(event) => {
						setQuery(event.currentTarget.value);
						setError("");
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && filtered.length === 0) {
							event.preventDefault();
							addCustom();
						}
					}}
				/>
				<button type="button" disabled={!query.trim()} onClick={addCustom}>Use this id</button>
			</div>
			<p class="custom-model-hint">Bundled catalog may lag the provider. Any valid model id works.</p>
			{error && <p class="custom-model-error">{error}</p>}
			<div class="model-list">
				{filtered.map((model) => {
					const custom = customIds.includes(model.id);
					return (
						<div class={`model-row${state.model?.id === model.id ? " selected" : ""}`} key={model.id}>
							<button type="button" onClick={() => { controller.selectModel(model.id); onPicked(); }}>
								<span>
									<b>{model.name}</b>
									{model.name !== model.id && <code>{model.id}</code>}
								</span>
								<small>{state.model?.id === model.id ? <Check size={16} strokeWidth={2.2} aria-hidden="true" /> : custom ? "custom" : `${Math.round(model.contextWindow / 1000)}k`}</small>
							</button>
							{custom && (
								<button type="button" class="model-remove" aria-label={`Remove ${model.id}`} onClick={() => controller.removeCustomModel(model.id)}>
									<X size={14} strokeWidth={2} />
								</button>
							)}
						</div>
					);
				})}
				{filtered.length === 0 && query.trim() && (
					<button class="use-query" type="button" onClick={addCustom}>Use “{query.trim()}”</button>
				)}
			</div>
		</>
	);
}

function CompactNotice({ kind, text, workspace }: { kind: "branch" | "compaction"; text: string; workspace?: PublicAgentState["workspace"] }) {
	const [open, setOpen] = useState(false);
	return (
		<div class="compact-banner">
			<button type="button" class="compact-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				{kind === "branch" ? "Branch summary" : "History compacted"}
			</button>
			<Collapse open={open}>
				<Markdown text={text} workspace={workspace} />
			</Collapse>
		</div>
	);
}

function JumpLatest({ visible, onJump }: { visible: boolean; onJump: () => void }) {
	const ref = useRef<HTMLButtonElement>(null);
	const first = useRef(true);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		if (visible) {
			element.style.pointerEvents = "auto";
			element.tabIndex = 0;
			element.setAttribute("aria-hidden", "false");
		} else {
			element.tabIndex = -1;
			element.setAttribute("aria-hidden", "true");
		}
		void fadeSlide(element, visible, first.current).then(() => {
			if (!visible && element.getAttribute("aria-hidden") === "true") element.style.pointerEvents = "none";
		});
		first.current = false;
	}, [visible]);
	return (
		<button
			ref={ref}
			type="button"
			class="jump-latest"
			onClick={onJump}
			aria-hidden={!visible}
			tabIndex={visible ? 0 : -1}
			aria-label="Jump to latest"
		>
			<ArrowDownToLine size={18} strokeWidth={2} aria-hidden="true" />
		</button>
	);
}

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		void fadeInUp(element);
		const hide = window.setTimeout(() => {
			void playMotion(element, { opacity: 0, transform: "translateY(8px)" }, { duration: 0.16, ease: "easeIn" }).then(onDone);
		}, 2400);
		return () => window.clearTimeout(hide);
	}, [message]);
	return <div ref={ref} class="agent-toast" role="status">{message}</div>;
}

function ApprovalPanel({ approval, onApprove }: { approval: MutationRequest; onApprove: (decision: MutationDecision) => void }) {
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		void fadeInUp(element);
	}, [approval.id]);
	return (
		<section ref={ref} class="approval" role="alertdialog" aria-label="Approve agent edit">
			<header>
				<span>Edit</span>
				<strong>{approval.title}</strong>
			</header>
			<pre>{approval.preview}</pre>
			<div class="approval-actions">
				<button type="button" onClick={() => onApprove("deny")}>Deny</button>
				<button type="button" onClick={() => onApprove("allow-session")}>Allow this session</button>
				<button class="primary" type="button" onClick={() => onApprove("allow")}>Allow once</button>
			</div>
		</section>
	);
}

function workspaceLabel(chat: ChatSummary, workspaces: WorkspaceInfo[]): string {
	return workspaces.find((workspace) => workspace.id === chat.workspaceId)?.name
		|| chat.workspaceName
		|| "Closed folder";
}

function formatChatTime(timestamp: number): string {
	const delta = Date.now() - timestamp;
	if (delta < 45_000) return "Just now";
	if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
	if (delta < 22 * 3_600_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
	const now = new Date();
	const date = new Date(timestamp);
	const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (timestamp >= startToday - 86_400_000) return "Yesterday";
	if (now.getFullYear() === date.getFullYear()) {
		return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function groupChatsByRecency(chats: ChatSummary[]): Array<{ id: string; label: string; chats: ChatSummary[] }> {
	const now = new Date();
	const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const buckets = {
		today: { id: "today", label: "Today", chats: [] as ChatSummary[] },
		yesterday: { id: "yesterday", label: "Yesterday", chats: [] as ChatSummary[] },
		week: { id: "week", label: "This week", chats: [] as ChatSummary[] },
		older: { id: "older", label: "Earlier", chats: [] as ChatSummary[] },
	};
	for (const chat of chats) {
		if (chat.updatedAt >= startToday) buckets.today.chats.push(chat);
		else if (chat.updatedAt >= startToday - 86_400_000) buckets.yesterday.chats.push(chat);
		else if (chat.updatedAt >= startToday - 6 * 86_400_000) buckets.week.chats.push(chat);
		else buckets.older.chats.push(chat);
	}
	return Object.values(buckets).filter((group) => group.chats.length);
}
