import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, Ellipsis, ListPlus, Plus, Send, Settings, Square, X } from "lucide-preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import { PERMISSION_MODES, type PermissionMode } from "../core/schema";
import type { ProviderId, PublicAgentState, QueuedPrompt } from "../core/types";
import { PROVIDERS } from "../providers/providerRegistry";
import { thinkingLevelsFor } from "../providers/thinkingLevels";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./markdown";
import { buildTurns } from "./transcript";
import { useChatScroll } from "./useChatScroll";
import { WorkingIndicator, WorkLog } from "./WorkLog";

type Props = { controller: AgentController };

export function App({ controller }: Props) {
	const [state, setState] = useState<PublicAgentState>(controller.state);
	const [composer, setComposer] = useState("");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [configOpen, setConfigOpen] = useState(false);
	const [chatsOpen, setChatsOpen] = useState(false);
	const [toast, setToast] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => controller.changes.subscribe(setState), [controller]);
	const running = state.status === "running";
	const followKey = `${state.activeChatId}:${state.messages.length}:${running ? "run" : "idle"}:${state.queued.length}:${state.compacting ? "c" : ""}:${state.activities.length}:${state.activities.at(-1)?.status ?? ""}:${state.approval?.id ?? ""}`;
	const { showLatest, jumpToLatest, pin } = useChatScroll(scrollRef, followKey);
	useEffect(() => {
		if (!toast) return;
		const timer = window.setTimeout(() => setToast(""), 2600);
		return () => window.clearTimeout(timer);
	}, [toast]);

	const turns = useMemo(
		() => buildTurns(state.messages, running ? state.streamingMessage : undefined, state.activities, running),
		[state.messages, state.streamingMessage, state.activities, running],
	);

	const send = useCallback(async (mode: "steer" | "followUp" = "steer") => {
		const message = composer.trim();
		if (!message) return;
		setComposer("");
		pin();
		try {
			await controller.send(message, mode);
		} catch (error) {
			setComposer(message);
			setToast(error instanceof Error ? error.message : String(error));
		}
	}, [composer, controller, pin]);

	const stop = useCallback(async () => {
		const restored = await controller.abort();
		if (restored.length) setComposer((current) => [current, ...restored].filter(Boolean).join("\n"));
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
					<EmptyState hasWorkspace={Boolean(state.workspace)} onPrompt={setComposer} onSettings={() => setSettingsOpen(true)} />
				) : (
					<div class="thread">
						{turns.map((turn) => (
							<section class="turn" key={turn.id}>
								{turn.user && <article class="bubble user"><p>{turn.user}</p></article>}
								{turn.notice && (
									<details class="compact-banner">
										<summary>{turn.notice.kind === "branch" ? "Branch summary" : "History compacted"}</summary>
										<Markdown text={turn.notice.text} workspace={state.workspace} />
									</details>
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
				<button
					type="button"
					class={`jump-latest${showLatest && running ? " visible" : ""}`}
					onClick={jumpToLatest}
					aria-hidden={!(showLatest && running)}
					tabIndex={showLatest && running ? 0 : -1}
					aria-label="Jump to latest"
				>
					<ArrowDownToLine size={18} strokeWidth={2} aria-hidden="true" />
				</button>
			</main>

			{state.approval && (
				<section class="approval" role="alertdialog" aria-label="Approve agent edit">
					<header>
						<span>Edit</span>
						<strong>{state.approval.title}</strong>
					</header>
					<pre>{state.approval.preview}</pre>
					<div class="approval-actions">
						<button type="button" onClick={() => controller.approve("deny")}>Deny</button>
						<button type="button" onClick={() => controller.approve("allow-session")}>Allow this session</button>
						<button class="primary" type="button" onClick={() => controller.approve("allow")}>Allow once</button>
					</div>
				</section>
			)}

			<Composer
				value={composer}
				onChange={setComposer}
				onSend={(mode) => void send(mode)}
				onStop={() => void stop()}
				running={running}
				disabled={!state.workspace}
				permissionMode={state.settings.permissionMode}
				effort={state.settings.thinkingLevel}
				effortLevels={thinkingLevelsFor(state.model)}
				modelName={state.model?.name ?? "Model"}
				onOpenConfig={() => setConfigOpen(true)}
				usage={state.usage}
				contextTokens={state.contextTokens}
				contextWindow={state.model?.contextWindow}
				queued={state.queued}
			/>

			{chatsOpen && <ChatSheet controller={controller} state={state} onClose={() => setChatsOpen(false)} onError={setToast} />}
			{settingsOpen && <SettingsSheet controller={controller} state={state} onClose={() => setSettingsOpen(false)} onToast={setToast} />}
			{configOpen && <ConfigSheet controller={controller} state={state} onClose={() => setConfigOpen(false)} />}
			{toast && <div class="agent-toast" role="status">{toast}</div>}
		</div>
	);
}

function ChatSheet({ controller, state, onClose, onError }: { controller: AgentController; state: PublicAgentState; onClose: () => void; onError: (message: string) => void }) {
	const workspaces = controller.workspaces;
	return (
		<div class="sheet-backdrop" onClick={onClose}>
			<section class="sheet chats" onClick={(event) => event.stopPropagation()}>
				<header class="sheet-header">
					<h2>Chats</h2>
					<button type="button" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
				</header>
				{workspaces.length > 0 && (
					<label class="field-label">
						Workspace
						<select
							class="workspace-select"
							value={state.workspace?.id ?? ""}
							onChange={(event) => void controller.selectWorkspace(event.currentTarget.value).catch((error) => onError(String(error)))}
						>
							{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}
						</select>
					</label>
				)}
				<button class="use-query" type="button" onClick={() => void controller.newConversation().then(onClose).catch((error) => onError(String(error)))}>New chat</button>
				<div class="chat-list">
					{state.chats.map((chat) => (
						<div class={`chat-row${chat.id === state.activeChatId ? " selected" : ""}`} key={chat.id}>
							<button type="button" onClick={() => void controller.selectChat(chat.id).then(onClose).catch((error) => onError(String(error)))}>
								<span>
									<b>{chat.title}</b>
									<small>{chat.running ? "running" : new Date(chat.updatedAt).toLocaleString()}</small>
								</span>
								{chat.running && <i class="run-dot" />}
							</button>
							<button type="button" class="model-remove" aria-label={`Delete ${chat.title}`} onClick={() => void controller.deleteChat(chat.id)}><X size={14} strokeWidth={2} /></button>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}

function EmptyState({ hasWorkspace, onPrompt, onSettings }: { hasWorkspace: boolean; onPrompt: (value: string) => void; onSettings: () => void }) {
	return (
		<section class="empty-state">
			<h1>{hasWorkspace ? "What should we work on?" : "Open a folder first"}</h1>
			<p>
				{hasWorkspace
					? "The agent can read the workspace, search files, and propose edits."
					: "Add a project folder in the Acode sidebar so the agent has a sandbox."}
			</p>
			{hasWorkspace && (
				<div class="suggestions">
					<button type="button" onClick={() => onPrompt("Map this project and explain how the main pieces fit together.")}>Map the project</button>
					<button type="button" onClick={() => onPrompt("Review the active file and fix the highest-impact issue.")}>Review the open file</button>
					<button type="button" onClick={onSettings}>Add a provider key</button>
				</div>
			)}
		</section>
	);
}

function Composer(props: {
	value: string;
	onChange: (value: string) => void;
	onSend: (mode?: "steer" | "followUp") => void;
	onStop: () => void;
	running: boolean;
	disabled: boolean;
	permissionMode: PermissionMode;
	effort: string;
	effortLevels: Array<{ id: string; label: string }>;
	modelName: string;
	onOpenConfig: () => void;
	usage: { tokens: number; cost: number };
	contextTokens: number;
	contextWindow?: number;
	queued: QueuedPrompt[];
}) {
	const textarea = useRef<HTMLTextAreaElement>(null);
	const canSend = Boolean(props.value.trim()) && !props.disabled;
	const showStop = props.running && !props.value.trim();
	useEffect(() => {
		const element = textarea.current;
		if (!element) return;
		element.style.height = "0";
		element.style.height = `${Math.min(120, Math.max(52, element.scrollHeight))}px`;
	}, [props.value]);
	const used = props.contextWindow ? Math.min(100, Math.round((props.contextTokens / props.contextWindow) * 100)) : 0;
	return (
		<footer class="composer">
			<div class="composer-dock">
				{props.queued.length > 0 && (
					<div class="queue-list" aria-label="Queued prompts">
						{props.queued.map((item, index) => (
							<span class={`queue-chip ${item.mode}`} key={`${item.mode}-${index}`}>
								{item.mode === "followUp" ? "After" : "Steer"}
								{" "}
								{item.text}
							</span>
						))}
					</div>
				)}
				<textarea
					ref={textarea}
					value={props.value}
					placeholder={props.disabled ? "Open a folder to begin" : props.running ? "Steer now, or queue a follow-up…" : "Ask anything…"}
					rows={1}
					onInput={(event) => props.onChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
							event.preventDefault();
							props.onSend(event.shiftKey ? "followUp" : "steer");
						}
					}}
				/>
				<div class="composer-toolbar">
					<button class="config-chip" type="button" onClick={props.onOpenConfig} aria-label="Session configuration">
						<Settings size={16} strokeWidth={2} aria-hidden="true" />
						<span class="mode">{PERMISSION_MODES.find((mode) => mode.id === props.permissionMode)?.label ?? "Ask"}</span>
						<span class="sep">·</span>
						<span class="effort">{props.effortLevels.find((level) => level.id === props.effort)?.label ?? props.effort}</span>
						<span class="sep">·</span>
						<span class="model">{props.modelName}</span>
					</button>
					{props.contextWindow ? (
						<span
							class={`context-meter${used >= 90 ? " danger" : used >= 70 ? " warn" : ""}`}
							style={{ "--used": `${used}%` } as Record<string, string>}
							title={`${formatTokens(props.contextTokens)} of ${formatTokens(props.contextWindow)}`}
							aria-label="Context window"
						/>
					) : null}
					{showStop ? (
						<button class="composer-action stop" type="button" onClick={props.onStop} aria-label="Stop generation">
							<Square size={16} strokeWidth={2.4} aria-hidden="true" />
						</button>
					) : (
						<>
							{props.running && (
								<button class="composer-action follow" type="button" onClick={() => props.onSend("followUp")} disabled={!canSend} aria-label="Queue follow-up">
									<ListPlus size={16} strokeWidth={2} aria-hidden="true" />
								</button>
							)}
							<button class="composer-action send" type="button" onClick={() => props.onSend("steer")} disabled={!canSend} aria-label={props.running ? "Steer agent" : "Send"}>
								<Send size={16} strokeWidth={2} aria-hidden="true" />
							</button>
						</>
					)}
				</div>
			</div>
		</footer>
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
		<div class="sheet-backdrop" onClick={onClose}>
			<section class="sheet" onClick={(event) => event.stopPropagation()}>
				<header class="sheet-header">
					<h2>Settings</h2>
					<button type="button" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
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
			</section>
		</div>
	);
}

function ConfigSheet({ controller, state, onClose }: { controller: AgentController; state: PublicAgentState; onClose: () => void }) {
	const [view, setView] = useState<"main" | "providers" | "models">("main");
	const [error, setError] = useState("");
	const provider = PROVIDERS.find((item) => item.id === state.settings.providerId);
	const modelId = state.model?.id ?? state.settings.modelId;
	const modelName = state.model?.name ?? "Choose model";
	return (
		<div class="sheet-backdrop" onClick={onClose}>
			<section class={`sheet config${view === "main" ? "" : " picker"}`} onClick={(event) => event.stopPropagation()}>
				<div class="sheet-handle" />
				{view === "providers" ? (
					<>
						<header class="sheet-header with-back">
							<button type="button" class="sheet-back" onClick={() => setView("main")} aria-label="Back">
								<ChevronLeft size={20} strokeWidth={2} />
							</button>
							<h2>Provider</h2>
							<button type="button" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
						</header>
						<div class="picker-body">
							<ProviderPicker
								state={state}
								error={error}
								onPick={(providerId) => {
									setError("");
									void controller.selectProvider(providerId).then(() => setView("models")).catch((caught) => {
										setError(caught instanceof Error ? caught.message : String(caught));
									});
								}}
							/>
						</div>
					</>
				) : view === "models" ? (
					<>
						<header class="sheet-header with-back">
							<button type="button" class="sheet-back" onClick={() => setView("main")} aria-label="Back">
								<ChevronLeft size={20} strokeWidth={2} />
							</button>
							<h2>Model</h2>
							<button type="button" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
						</header>
						<div class="picker-body">
							<ModelPicker controller={controller} state={state} onPicked={onClose} />
						</div>
					</>
				) : (
					<>
						<header class="sheet-header">
							<h2>Session</h2>
							<button type="button" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
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
						<button type="button" class="config-nav" onClick={() => setView("providers")}>
							<div>
								<b>Provider</b>
								<small>{provider?.hint ?? "Choose a provider"}</small>
							</div>
							<span class="config-nav-value">{provider?.name ?? state.settings.providerId}</span>
							<ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
						</button>
						<button type="button" class="config-nav" onClick={() => setView("models")}>
							<div>
								<b>Model</b>
								{modelName !== modelId && <small>{modelId}</small>}
							</div>
							<span class="config-nav-value">{modelName}</span>
							<ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
						</button>
					</>
				)}
			</section>
		</div>
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

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens` : `${tokens} tokens`;
}
