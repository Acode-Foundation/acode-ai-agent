import { ArrowDownToLine, Check, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Folder, Plus, Trash2, X } from "lucide-preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentController, CommandPanelData } from "../app/agentController";
import { PERMISSION_MODES } from "../core/schema";
import type { ChatSummary, MutationDecision, MutationRequest, ProviderId, PublicAgentState, WorkspaceInfo } from "../core/types";
import { PROVIDERS } from "../providers/providerRegistry";
import { thinkingLevelsFor } from "../providers/thinkingLevels";
import { backActionId, useBackAction } from "./actionStack";
import { Collapse } from "./Collapse";
import { Composer, UserMessage, type ComposerHandle } from "./Composer";
import { CopyButton } from "./CopyButton";
import { ErrorNotice } from "./ErrorNotice";
import { fadeInUp, fadeSlide, playMotion } from "./motion";
import { Markdown } from "./markdown";
import { Sheet } from "./Sheet";
import { TreeSheet } from "./TreeSheet";
import { buildTurns } from "./transcript";
import { useChatScroll } from "./useChatScroll";
import { WorkingIndicator, WorkLog } from "./WorkLog";
import { openCustomTab } from "../platform/authTab";
import { previewImageInAcode } from "../platform/deviceImage";
import { pickAcodeSelect } from "../platform/acodeSelect";
import { modelAcceptsImages } from "../platform/promptImages";
import { draftFromParts, promptTextFromDraft, type ComposerDraft } from "./composerDraft";
import { parseSlashCommand } from "../core/slashCommands";

type Props = {
	controller: AgentController;
	onActiveChatChange?: (chatId: string) => void;
};

export function App({ controller, onActiveChatChange }: Props) {
	const [state, setState] = useState<PublicAgentState>(controller.state);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [piSettingsOpen, setPiSettingsOpen] = useState(false);
	const [configView, setConfigView] = useState<"main" | "models" | null>(null);
	const [chatsOpen, setChatsOpen] = useState(false);
	const [commandPanel, setCommandPanel] = useState<CommandPanelData | null>(null);
	const [treeMode, setTreeMode] = useState<"tree" | "fork" | null>(null);
	const [toast, setToast] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const composerRef = useRef<ComposerHandle>(null);
	const bindingReady = useRef(false);

	useEffect(() => controller.changes.subscribe(setState), [controller]);
	useEffect(() => {
		if (!bindingReady.current) {
			bindingReady.current = true;
			return;
		}
		if (state.activeChatId) onActiveChatChange?.(state.activeChatId);
	}, [state.activeChatId, onActiveChatChange]);
	const running = state.status === "running";
	const followKey = `${state.activeChatId}:${state.messages.length}:${running ? "run" : "idle"}:${state.queued.length}:${state.compacting ? "c" : ""}:${state.activities.length}:${state.activities.at(-1)?.status ?? ""}:${state.approval?.id ?? ""}`;
	const { showLatest, jumpToLatest, pin, captureThread } = useChatScroll(scrollRef, followKey);

	const turns = useMemo(() => {
		const built = buildTurns(state.messages, running ? state.streamingMessage : undefined, state.activities, running);
		if (!state.settings.hideThinkingBlock) return built;
		return built.map((turn) => ({ ...turn, work: turn.work.filter((item) => item.type !== "thinking") }));
	}, [state.messages, state.streamingMessage, state.activities, state.settings.hideThinkingBlock, running]);

	const send = useCallback(async (draft: ComposerDraft, mode: "steer" | "followUp" = "steer") => {
		if (!draft.text.trim() && !draft.images.length && !draft.files.length) return;
		pin();
		try {
			const command = parseSlashCommand(draft.text);
			if (command) {
				if (draft.images.length || draft.files.length) throw new Error("Slash commands cannot include attachments.");
				const result = await controller.executeSlashCommand(command.name, command.args);
				if (result.copyText) await navigator.clipboard.writeText(result.copyText);
				if (result.action === "models") setConfigView("models");
				if (result.action === "settings") setSettingsOpen(true);
				if (result.action === "pi-settings") setPiSettingsOpen(true);
				if (result.action === "sessions") setChatsOpen(true);
				if (result.action === "tree" || result.action === "fork") setTreeMode(result.action);
				if (result.panel) setCommandPanel(result.panel);
				if (result.message) setToast(result.message);
				return;
			}
			await controller.send(promptTextFromDraft(draft), mode, draft.images);
		} catch (error) {
			composerRef.current?.restore(draft);
			setToast(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}, [controller, pin]);

	const stop = useCallback(async () => {
		const restored = await controller.abort();
		if (!restored.length) return;
		const text = restored.map((item) => item.text).filter(Boolean).join("\n");
		composerRef.current?.restore(draftFromParts(
			text,
			restored.flatMap((item, index) => item.images.map((image) => ({
				...image,
				id: `${index}-${image.mimeType}-${image.data.length}`,
				name: "image",
			}))),
		));
	}, [controller]);

	return (
		<div class="agent-shell">
			<header class="agent-header">
				<button class="chat-trigger" type="button" onClick={() => setChatsOpen(true)}>
					<span>{state.chats.find((chat) => chat.id === state.activeChatId)?.title ?? "New chat"}</span>
					{state.chats.some((chat) => chat.running && chat.id !== state.activeChatId) && <i class="bg-run" />}
				</button>
				<button class="icon-button" type="button" onClick={() => void controller.newConversation().catch((error) => setToast(String(error)))} aria-label="New chat"><Plus size={18} strokeWidth={2} /></button>
				<button class="icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Provider access"><Ellipsis size={18} strokeWidth={2} /></button>
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
								{turn.error && <ErrorNotice message={turn.error} />}
								{turn.streaming && <WorkingIndicator startedAt={turn.startedAt} />}
							</section>
						))}
						{state.compacting && <div class="compact-status">Compacting earlier turns…</div>}
						{running && !state.compacting && !turns.some((turn) => turn.streaming) && <WorkingIndicator />}
					</div>
				)}
				{state.error && <ErrorNotice message={state.error} />}
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
				commands={state.commands}
				autocompleteMaxVisible={state.settings.autocompleteMaxVisible}
				onOpenConfig={() => setConfigView("main")}
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
			{settingsOpen && <SettingsSheet controller={controller} state={state} onClose={() => setSettingsOpen(false)} onOpenPiSettings={() => { setSettingsOpen(false); setPiSettingsOpen(true); }} onToast={setToast} />}
			{piSettingsOpen && <PiSettingsSheet controller={controller} state={state} onClose={() => setPiSettingsOpen(false)} onCredentials={() => { setPiSettingsOpen(false); setSettingsOpen(true); }} onPanel={setCommandPanel} onToast={setToast} />}
			{configView && <ConfigSheet controller={controller} state={state} initialView={configView} onClose={() => setConfigView(null)} onOpenPiSettings={() => { setConfigView(null); setPiSettingsOpen(true); }} />}
			{commandPanel && <CommandResultSheet panel={commandPanel} onClose={() => setCommandPanel(null)} onToast={setToast} />}
			{treeMode && <TreeSheet controller={controller} mode={treeMode} onClose={() => setTreeMode(null)} onError={setToast} onRestorePrompt={(text) => composerRef.current?.setText(text)} />}
			{toast && <Toast message={toast} onDone={() => setToast("")} />}
		</div>
	);
}

function ChatSheet({ controller, state, onClose, onError }: { controller: AgentController; state: PublicAgentState; onClose: () => void; onError: (message: string) => void }) {
	const workspaces = controller.workspaces;
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [filter, setFilter] = useState<string>(state.workspace?.id ?? "all");
	const showFilter = workspaces.length > 0;
	useEffect(() => {
		if (filter !== "all" && !workspaces.some((workspace) => workspace.id === filter)) setFilter("all");
	}, [filter, workspaces]);
	const chats = useMemo(
		() => filter === "all" ? state.chats : state.chats.filter((chat) => chat.workspaceId === filter),
		[state.chats, filter],
	);
	const groups = useMemo(() => groupChatsByRecency(chats), [chats]);
	const fail = (error: unknown) => onError(error instanceof Error ? error.message : String(error));
	const chooseFilter = (next: string) => {
		setConfirmId(null);
		setFilter(next);
	};
	const startNew = (close: () => void) => {
		const create = () => controller.newConversation().then(close).catch(fail);
		if (filter !== "all" && filter !== state.workspace?.id) {
			void controller.selectWorkspace(filter).then(create).catch(fail);
			return;
		}
		void create();
	};
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
						{showFilter && (
							<ProjectFilter workspaces={workspaces} value={filter} onChange={chooseFilter} />
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
														<small class="chat-meta">
															{filter === "all" && (
																<>
																	<span class="chat-project">{workspaceLabel(chat, workspaces)}</span>
																	<span class="chat-sep">·</span>
																</>
															)}
															<span class="chat-time">{chat.running ? "Running" : formatChatTime(chat.updatedAt)}</span>
															{chat.id === state.activeChatId ? <span class="chat-current">· current</span> : null}
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

function ProjectFilter({ workspaces, value, onChange }: { workspaces: WorkspaceInfo[]; value: string; onChange: (id: string) => void }) {
	const label = value === "all"
		? "All folders"
		: workspaces.find((workspace) => workspace.id === value)?.name ?? "Folder";
	const native = typeof acode?.select !== "function";
	const open = () => {
		void pickAcodeSelect("Folder", [
			{ value: "all", text: "All folders", icon: "folder-outline" },
			...workspaces.map((workspace) => ({ value: workspace.id, text: workspace.name, icon: "folder" })),
		], value).then((picked) => {
			if (picked) onChange(picked);
		});
	};
	if (native) {
		return (
			<label class="project-select">
				<Folder size={14} strokeWidth={2} aria-hidden="true" />
				<select value={value} aria-label="Filter sessions by folder" onChange={(event) => onChange(event.currentTarget.value)}>
					<option value="all">All folders</option>
					{workspaces.map((workspace) => (
						<option value={workspace.id} key={workspace.id}>{workspace.name}</option>
					))}
				</select>
				<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
			</label>
		);
	}
	return (
		<button type="button" class="project-select" title={label} aria-haspopup="listbox" aria-label="Filter sessions by folder" onClick={open}>
			<Folder size={14} strokeWidth={2} aria-hidden="true" />
			<span>{label}</span>
			<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
		</button>
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
					? "The agent can read the workspace, search the web, search files, and propose edits."
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

function SettingsSheet({ controller, state, onClose, onOpenPiSettings, onToast }: { controller: AgentController; state: PublicAgentState; onClose: () => void; onOpenPiSettings: () => void; onToast: (message: string) => void }) {
	const [providerId, setProviderId] = useState<ProviderId>(PROVIDERS.some((item) => item.id === state.settings.providerId) ? state.settings.providerId : PROVIDERS[0]!.id);
	const [key, setKey] = useState("");
	const [authPromptValue, setAuthPromptValue] = useState("");
	const [connected, setConnected] = useState(false);
	useEffect(() => { void controller.hasCredential(providerId).then(setConnected); }, [controller, providerId, state.authFlow?.status]);
	const provider = PROVIDERS.find((item) => item.id === providerId)!;
	const authFlow = state.authFlow?.providerId === providerId ? state.authFlow : undefined;
	const authPromptKey = `${providerId}:${authFlow?.prompt?.type ?? ""}:${authFlow?.prompt?.message ?? ""}`;
	useEffect(() => setAuthPromptValue(""), [authPromptKey]);
	return (
		<Sheet onClose={onClose}>
			{(close) => (
				<>
				<header class="sheet-header">
					<h2>Provider access</h2>
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
							{provider.keyUrl && (
								<a
									href={provider.keyUrl}
									onClick={(event) => {
										event.preventDefault();
										void openCustomTab(provider.keyUrl!).catch((error) => onToast(error instanceof Error ? error.message : String(error)));
									}}
								>
									Get an API key
								</a>
							)}
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
									{authFlow.prompt && (
										<SubscriptionPrompt
											prompt={authFlow.prompt}
											value={authPromptValue}
											onValue={setAuthPromptValue}
											onSubmit={(value) => controller.submitSubscriptionPrompt(value)}
										/>
									)}
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
				<button class="config-nav" type="button" onClick={() => { close(); onOpenPiSettings(); }}>
					<div><b>Pi settings</b><small>Compaction, skills, message delivery, and display</small></div>
					<ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
				</button>
				</>
			)}
		</Sheet>
	);
}

function SubscriptionPrompt({ prompt, value, onValue, onSubmit }: {
	prompt: NonNullable<NonNullable<PublicAgentState["authFlow"]>["prompt"]>;
	value: string;
	onValue: (value: string) => void;
	onSubmit: (value: string) => void;
}) {
	if (prompt.type === "select") {
		return (
			<div class="auth-options" role="group" aria-label={prompt.message}>
				{prompt.options?.map((option) => (
					<button type="button" key={option.id} onClick={() => onSubmit(option.id)}>
						<span>{option.label}</span>
						{option.description && <small>{option.description}</small>}
					</button>
				))}
			</div>
		);
	}
	const required = prompt.type === "manual_code" || prompt.type === "secret";
	return (
		<form class="auth-prompt-input" onSubmit={(event) => {
			event.preventDefault();
			if (!required || value.trim()) onSubmit(value);
		}}>
			<input
				type={prompt.type === "secret" ? "password" : "text"}
				value={value}
				placeholder={prompt.placeholder}
				autoCapitalize="none"
				autoCorrect="off"
				onInput={(event) => onValue(event.currentTarget.value)}
			/>
			<button type="submit" disabled={required && !value.trim()}>Continue</button>
		</form>
	);
}

function PiSettingsSheet({
	controller,
	state,
	onClose,
	onCredentials,
	onPanel,
	onToast,
}: {
	controller: AgentController;
	state: PublicAgentState;
	onClose: () => void;
	onCredentials: () => void;
	onPanel: (panel: CommandPanelData) => void;
	onToast: (message: string) => void;
}) {
	const settings = state.settings;
	const update = (patch: Partial<typeof settings>) => controller.settings.update(patch);
	const addSkills = () => {
		void controller.addGlobalSkillRoot().then((loaded) => {
			if (!loaded) return;
			onClose();
			onPanel({
				title: "Pi resources",
				description: `${loaded.skills.length} skills · ${loaded.prompts.length} prompts`,
				body: loaded.skills.length ? loaded.skills.map((name) => `/skill:${name}`).join("\n") : "No valid skills were found in that folder.",
			});
		}).catch((error) => onToast(error instanceof Error ? error.message : String(error)));
	};
	return (
		<Sheet class="pi-settings" onClose={onClose}>
			{(close) => (
				<>
					<div class="sheet-handle" />
					<header class="sheet-header">
						<div><h2>Pi settings</h2><small>Pi defaults are used unless changed here</small></div>
						<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
					</header>
					<div class="pi-settings-body">
						<SettingsToggle label="Auto-compact" hint="Automatically compact context when it gets too large" checked={settings.autoCompaction} onChange={(value) => update({ autoCompaction: value })} />
						<SettingsToggle label="Auto-resize images" hint="Resize large images for model compatibility" checked={settings.imageAutoResize} onChange={(value) => update({ imageAutoResize: value })} />
						<SettingsToggle label="Skill commands" hint="Register discovered skills as /skill:name" checked={settings.enableSkillCommands} onChange={(value) => update({ enableSkillCommands: value })} />
						<SettingsSelect label="Steering mode" hint="How messages sent during a run are delivered" value={settings.steeringMode} options={[{ value: "one-at-a-time", label: "One at a time" }, { value: "all", label: "All" }]} onChange={(value) => update({ steeringMode: value as typeof settings.steeringMode })} />
						<SettingsSelect label="Follow-up mode" hint="How queued follow-ups are delivered" value={settings.followUpMode} options={[{ value: "one-at-a-time", label: "One at a time" }, { value: "all", label: "All" }]} onChange={(value) => update({ followUpMode: value as typeof settings.followUpMode })} />
						<SettingsToggle label="Hide thinking" hint="Hide thinking blocks in assistant responses" checked={settings.hideThinkingBlock} onChange={(value) => update({ hideThinkingBlock: value })} />
						<SettingsSelect label="Autocomplete max items" hint="Visible items in the @ and / picker" value={String(settings.autocompleteMaxVisible)} options={[7, 10, 15, 20].map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => update({ autocompleteMaxVisible: Number(value) })} />

						<section class="settings-section">
							<header><b>Skills</b><small>Project skills are detected automatically from .pi/skills and .agents/skills</small></header>
							{settings.globalSkillRoots.map((root) => (
								<div class="skill-root" key={root}>
									<code>{root}</code>
									<button type="button" aria-label="Remove skills folder" onClick={() => void controller.removeGlobalSkillRoot(root).catch((error) => onToast(String(error)))}><Trash2 size={14} strokeWidth={2} /></button>
								</div>
							))}
							<button class="settings-action" type="button" onClick={addSkills}><Folder size={15} strokeWidth={2} /> Add global skills folder</button>
						</section>
						<button class="config-nav" type="button" onClick={onCredentials}>
							<div><b>Provider credentials</b><small>Sign in or manage API keys</small></div>
							<ChevronRight size={18} strokeWidth={2} />
						</button>
					</div>
				</>
			)}
		</Sheet>
	);
}

function SettingsToggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
	return (
		<label class="setting-row">
			<span><b>{label}</b><small>{hint}</small></span>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
		</label>
	);
}

function SettingsSelect({ label, hint, value, options, onChange }: { label: string; hint: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
	const selected = options.find((option) => option.value === value)?.label ?? value;
	const choose = () => {
		void pickAcodeSelect(label, options.map((option) => ({ value: option.value, text: option.label })), value).then((next) => {
			if (next !== undefined) onChange(next);
		});
	};
	return (
		<div class="setting-row">
			<span><b>{label}</b><small>{hint}</small></span>
			<button class="setting-choice" type="button" onClick={choose}><span>{selected}</span><ChevronDown size={14} strokeWidth={2} /></button>
		</div>
	);
}

function CommandResultSheet({ panel, onClose, onToast }: { panel: CommandPanelData; onClose: () => void; onToast: (message: string) => void }) {
	const copy = () => {
		void navigator.clipboard.writeText(panel.copyText ?? panel.body ?? "").then(() => onToast("Copied"));
	};
	return (
		<Sheet class="command-result" onClose={onClose}>
			{(close) => (
				<>
					<div class="sheet-handle" />
					<header class="sheet-header">
						<div><h2>{panel.title}</h2>{panel.description && <small>{panel.description}</small>}</div>
						<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
					</header>
					<div class="command-result-body">
						{panel.rows?.map((row) => <div class="result-row" key={row.label}><span>{row.label}</span><b>{row.value}</b></div>)}
						{panel.body && (panel.markdown ? <Markdown text={panel.body} /> : <pre>{panel.body}</pre>)}
						{(panel.copyText || panel.body) && <button class="settings-action" type="button" onClick={copy}>Copy</button>}
					</div>
				</>
			)}
		</Sheet>
	);
}

function ConfigSheet({ controller, state, initialView, onClose, onOpenPiSettings }: { controller: AgentController; state: PublicAgentState; initialView: "main" | "models"; onClose: () => void; onOpenPiSettings: () => void }) {
	const [view, setView] = useState<"main" | "providers" | "models">(initialView);
	const [error, setError] = useState("");
	const bodyRef = useRef<HTMLDivElement>(null);
	const firstView = useRef(true);
	const provider = PROVIDERS.find((item) => item.id === state.settings.providerId);
	const effortLevels = thinkingLevelsFor(state.model);
	const modelId = state.model?.id ?? state.settings.modelId;
	const modelName = state.model?.name ?? "Choose model";
	useEffect(() => {
		if (view === "models") void controller.refreshModels();
	}, [controller, state.settings.providerId, view]);
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
								{effortLevels.length > 0 && (
									<div class="config-row">
										<div>
											<b>Effort</b>
											<small>Levels this model actually supports</small>
										</div>
										<div class="config-pills">
											{effortLevels.map((level) => (
												<button type="button" class={state.settings.thinkingLevel === level.id ? "selected effort" : ""} key={level.id} onClick={() => controller.setThinkingLevel(level.id)}>
													{level.label}
												</button>
											))}
										</div>
									</div>
								)}
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
								<button type="button" class="config-nav" onClick={onOpenPiSettings}>
									<div>
										<b>Pi settings</b>
										<small>Compaction, queues, skills, images, and transport</small>
									</div>
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
		<section ref={ref} class="approval" role="alertdialog" aria-label="Approve agent action">
			<header>
				<span>{approval.toolName === "bash" ? "Terminal" : "Edit"}</span>
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
