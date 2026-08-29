import {
	Bot,
	ChevronDown,
	ExternalLink,
	Folder,
	LoaderCircle,
	MessageSquarePlus,
	PanelTopOpen,
	Plus,
	Search,
	Sparkles,
	Trash2,
	X,
} from "lucide-preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { AgentController } from "../../app/agentController";
import type { ChatSummary, PublicAgentState, WorkspaceInfo } from "../../core/types";
import { pickAcodeSelect } from "../../platform/acodeSelect";

type Props = {
	controller: AgentController;
	onOpenAgent(): void;
	onOpenSession(chatId: string): Promise<void>;
	onOpenSessionInNewTab(chatId: string): Promise<void>;
	onNewSession(workspaceId: string): Promise<void>;
	onDeleteSession(chatId: string): Promise<void>;
	onCreateProject(): Promise<WorkspaceInfo>;
};

export function SidebarApp({
	controller,
	onOpenAgent,
	onOpenSession,
	onOpenSessionInNewTab,
	onNewSession,
	onDeleteSession,
	onCreateProject,
}: Props) {
	const [state, setState] = useState<PublicAgentState>(controller.state);
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState(() => controller.state.workspace?.id ?? "all");
	const [foldersOpen, setFoldersOpen] = useState(false);
	const [sessionsOpen, setSessionsOpen] = useState(true);
	const [pending, setPending] = useState<string | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

	useEffect(() => controller.changes.subscribe(setState), [controller]);
	const workspaces = controller.workspaces;
	const workspaceIds = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces]);
	const counts = useMemo(() => countSessions(state.chats), [state.chats]);
	const chats = useMemo(() => filterChats(state.chats, query, scope), [state.chats, query, scope]);
	const scopeLabel = scope === "all" ? "All projects" : workspaces.find((workspace) => workspace.id === scope)?.name ?? "All projects";
	const runningCount = state.chats.filter((chat) => chat.running).length;

	useEffect(() => {
		if (scope !== "all" && !workspaceIds.has(scope)) setScope("all");
	}, [scope, workspaceIds]);

	const run = async (key: string, action: () => Promise<void>) => {
		if (pending) return;
		setPending(key);
		setNotice(null);
		try {
			await action();
		} catch (error) {
			setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
		} finally {
			setPending(null);
		}
	};
	const chooseScope = () => {
		void pickAcodeSelect("Show sessions from", [
			{ value: "all", text: "All projects", icon: "folder-outline" },
			...workspaces.map((workspace) => ({ value: workspace.id, text: workspace.name, icon: "folder" })),
		], scope).then((picked) => {
			if (picked) setScope(picked);
		});
	};
	const startInOpenProject = () => {
		if (!workspaces.length) {
			setNotice({ kind: "error", text: "Open a project in Acode first." });
			return;
		}
		if (workspaces.length === 1) {
			void run(`new:${workspaces[0]!.id}`, () => onNewSession(workspaces[0]!.id));
			return;
		}
		void pickAcodeSelect(
			"Start a new session in",
			workspaces.map((workspace) => ({ value: workspace.id, text: workspace.name, icon: "folder" })),
			state.workspace?.id,
		).then((workspaceId) => {
			if (workspaceId) void run(`new:${workspaceId}`, () => onNewSession(workspaceId));
		});
	};

	return (
		<div class="acode-agent-sidebar">
			<header class="as-head">
				<div class="as-mark"><Bot size={16} strokeWidth={2} /></div>
				<div><b>AI Agent</b><small>{runningCount ? `${runningCount} running` : state.workspace?.name ?? "No active project"}</small></div>
				<div class="as-head-actions">
					<button
						type="button"
						disabled={Boolean(pending)}
						onClick={startInOpenProject}
						aria-label="New session"
						title="New session"
					>
						{pending?.startsWith("new:") ? <LoaderCircle class="as-spin" size={15} /> : <Plus size={16} />}
					</button>
					<button type="button" onClick={onOpenAgent} aria-label="Open Agent tab" title="Open Agent tab"><ExternalLink size={15} /></button>
				</div>
			</header>

			<div class="as-scroll scroll">

				<section class={`as-section${foldersOpen ? " expanded" : ""}`}>
					<button class="as-section-toggle" type="button" onClick={() => setFoldersOpen((open) => !open)} aria-expanded={foldersOpen}>
						<ChevronDown class="as-chevron" size={14} />
						<span>Open projects</span>
						<small>{workspaces.length}</small>
					</button>
					{foldersOpen ? (
						<div class="as-projects scroll">
							{workspaces.length ? workspaces.map((workspace) => (
								<div class={`as-project${workspace.id === state.workspace?.id ? " active" : ""}`} key={workspace.id}>
									<button class="as-project-select" type="button" onClick={() => setScope(workspace.id)} title={`Show ${workspace.name} sessions`}>
										<Folder size={14} />
										<span><b>{workspace.name}</b><small>{counts.get(workspace.id) ?? 0} sessions</small></span>
									</button>
									<button
										class="as-icon-action"
										type="button"
										disabled={Boolean(pending)}
										onClick={() => void run(`new:${workspace.id}`, () => onNewSession(workspace.id))}
										aria-label={`Start session in ${workspace.name}`}
									>
										{pending === `new:${workspace.id}` ? <LoaderCircle class="as-spin" size={14} /> : <MessageSquarePlus size={14} />}
									</button>
								</div>
							)) : <p class="as-empty-row">No project is open in Acode.</p>}
						</div>
					) : null}
				</section>

				<button
					class="as-create-project"
					type="button"
					disabled={Boolean(pending)}
					onClick={() => void run("project", async () => {
						const workspace = await onCreateProject();
						setScope(workspace.id);
						setNotice({ kind: "success", text: `${workspace.name} created in Home.` });
					})}
				>
					<span>{pending === "project" ? <LoaderCircle class="as-spin" size={18} /> : <Sparkles size={18} />}</span>
					<span><b>Spin up new session</b><small>Start in a random project</small></span>
				</button>

				<section class={`as-section as-session-section${sessionsOpen ? " expanded" : ""}`}>
					<button class="as-section-toggle" type="button" onClick={() => setSessionsOpen((open) => !open)} aria-expanded={sessionsOpen}>
						<ChevronDown class="as-chevron" size={14} />
						<span>Sessions</span>
						<small>{scope === "all" ? state.chats.length : counts.get(scope) ?? 0}</small>
					</button>

					{sessionsOpen ? (
						<div class="as-session-body">
							<div class="as-session-tools">
								<button class="as-scope" type="button" onClick={chooseScope}>
									<Folder size={13} /><span>{scopeLabel}</span><ChevronDown size={12} />
								</button>
								<label class="as-search">
									<Search size={13} />
									<input value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search sessions" aria-label="Search sessions" />
									{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={12} /></button> : null}
								</label>
							</div>

							{chats.length ? (
								<div class="as-session-list scroll">
									{chats.map((chat) => {
										const available = workspaceIds.has(chat.workspaceId);
										return (
											<div class={`as-session${chat.running ? " running" : ""}`} key={chat.id}>
												<button
													class="as-session-open"
													type="button"
													disabled={!available || Boolean(pending)}
													onClick={() => void run(`open:${chat.id}`, () => onOpenSession(chat.id))}
													title={available ? `Open ${chat.title}` : "Open this project in Acode to resume"}
												>
													<i class="as-status" aria-hidden="true" />
													<span><b>{chat.title}</b><small>{chat.workspaceName || "Closed project"} · {chat.running ? "running" : formatAge(chat.updatedAt)}</small></span>
												</button>
												<div class="as-session-actions">
													<button
														type="button"
														disabled={!available || Boolean(pending)}
														onClick={() => void run(`tab:${chat.id}`, () => onOpenSessionInNewTab(chat.id))}
														aria-label={`Open ${chat.title} in another tab`}
														title="Open in another tab"
													>
														<PanelTopOpen size={13} />
													</button>
													{confirmId === chat.id ? (
														<button class="as-delete confirm" type="button" onClick={() => void run(`delete:${chat.id}`, async () => {
															await onDeleteSession(chat.id);
															setConfirmId(null);
														})}>Delete</button>
													) : (
														<button class="as-delete" type="button" onClick={() => setConfirmId(chat.id)} aria-label={`Delete ${chat.title}`}><Trash2 size={13} /></button>
													)}
												</div>
											</div>
										);
									})}
								</div>
							) : (
								<div class="as-empty-sessions"><Bot size={18} /><p>{query ? "No matching sessions." : "No sessions in this scope."}</p></div>
							)}
						</div>
					) : null}
				</section>
			</div>

			{notice ? <button type="button" class={`as-notice ${notice.kind}`} onClick={() => setNotice(null)}><span>{notice.text}</span><X size={13} /></button> : null}
		</div>
	);
}

export function filterChats(chats: ChatSummary[], query: string, workspaceId = "all"): ChatSummary[] {
	const needle = query.trim().toLocaleLowerCase();
	const filtered: ChatSummary[] = [];
	for (const chat of chats) {
		if (workspaceId !== "all" && chat.workspaceId !== workspaceId) continue;
		if (needle && !`${chat.title} ${chat.workspaceName}`.toLocaleLowerCase().includes(needle)) continue;
		filtered.push(chat);
	}
	return filtered.sort((left, right) => right.updatedAt - left.updatedAt);
}

function countSessions(chats: ChatSummary[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const chat of chats) counts.set(chat.workspaceId, (counts.get(chat.workspaceId) ?? 0) + 1);
	return counts;
}

function formatAge(updatedAt: number): string {
	const elapsed = Math.max(0, Date.now() - updatedAt);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return days < 7 ? `${days}d` : new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
