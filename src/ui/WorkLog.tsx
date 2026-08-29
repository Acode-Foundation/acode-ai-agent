import { ChevronDown, ChevronRight, ExternalLink, Eye, File, Folder, FolderOpen, Globe, ListPlus, LoaderCircle, Pencil, Search, Sparkles, SquareTerminal, Wrench } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Collapse, RotateIcon } from "./Collapse";
import { Markdown } from "./markdown";
import { ErrorNotice } from "./ErrorNotice";
import type { WorkspaceInfo } from "../core/types";
import { openCustomTab } from "../platform/authTab";
import { openWorkspaceFile } from "../platform/editorNavigation";
import { loadDiffViewRuntime } from "../platform/pluginAssets";
import { parseWebSearchOutput } from "../tools/web/format";
import { formatWorkDuration, groupWorkEntries, parseDirListing, parseToolFileResults, splitWorkBurst, turnDurationMs, type ChatTurn, type DirEntry, type FileResult, type ToolKind, type WorkEntry } from "./transcript";

/** Survives WorkLog remounts when a stream tick rebuilds the turn tree. */
const workRowOpen = new Map<string, boolean>();

export function WorkLog({ turn, workspace }: { turn: ChatTurn; workspace?: WorkspaceInfo }) {
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (turn.streaming) setExpanded(false);
	}, [turn.streaming]);

	if (!turn.work.length) return null;

	const groups = groupWorkEntries(turn.work);
	const duration = turnDurationMs(turn);
	const body = (
		<div class={turn.streaming ? "work-stream" : "work-list"}>
			{groups.map((group, index) => (
				group.kind === "content"
					? <WorkContent key={group.entry.id} turnId={turn.id} entry={group.entry} workspace={workspace} />
					: <WorkBurst key={`burst-${group.entries[0]?.id ?? index}`} turnId={turn.id} entries={group.entries} workspace={workspace} live={turn.streaming} />
			))}
		</div>
	);

	if (turn.streaming) return body;

	return (
		<section class="work-log settled" aria-label="Work log">
			<button type="button" class="work-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
				<span>{duration === undefined ? "Worked" : `Worked for ${formatWorkDuration(duration)}`}</span>
				<RotateIcon open={expanded} class="work-chevron">
					<ChevronRight size={14} strokeWidth={2} />
				</RotateIcon>
			</button>
			<Collapse open={expanded}>{body}</Collapse>
		</section>
	);
}

export function WorkingIndicator({ startedAt, label }: { startedAt?: number; label?: string }) {
	const labelRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const started = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now();
		const update = () => {
			if (!labelRef.current) return;
			const seconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
			const elapsed = seconds > 0 ? formatWorkDuration(seconds * 1_000) : "";
			if (label) labelRef.current.textContent = elapsed ? `${label} · ${elapsed}` : label;
			else labelRef.current.textContent = elapsed ? `Working for ${elapsed}` : "Working";
		};
		update();
		const timer = window.setInterval(update, 1_000);
		return () => window.clearInterval(timer);
	}, [startedAt, label]);
	return (
		<div class="typing" aria-live="polite">
			<span class="work-dots" aria-hidden="true"><i /><i /><i /></span>
			<span ref={labelRef}>{label || "Working"}</span>
		</div>
	);
}

function WorkBurst({ turnId, entries, workspace, live }: { turnId: string; entries: WorkEntry[]; workspace?: WorkspaceInfo; live?: boolean }) {
	const [showPrevious, setShowPrevious] = useState(false);
	const { featured, grouped } = splitWorkBurst(entries, Boolean(live));
	if (!featured.length) return null;
	return (
		<div class="work-burst">
			<Collapse open={showPrevious}>
				{grouped.map((entry) => (
					<WorkRow key={entry.id} turnId={turnId} entry={entry} workspace={workspace} />
				))}
			</Collapse>
			{featured.map((entry) => (
				<WorkRow key={entry.id} turnId={turnId} entry={entry} workspace={workspace} />
			))}
			{grouped.length > 0 && (
				<button type="button" class="work-more" aria-expanded={showPrevious} onClick={() => setShowPrevious((value) => !value)}>
					<RotateIcon open={showPrevious} degrees={180} class="work-more-icon">
						<ChevronDown size={14} strokeWidth={2} />
					</RotateIcon>
					<span>{showPrevious ? "Show fewer tool calls" : `+${grouped.length} previous tool ${grouped.length === 1 ? "call" : "calls"}`}</span>
				</button>
			)}
		</div>
	);
}

function WorkContent({ turnId, entry, workspace }: { turnId: string; entry: WorkEntry; workspace?: WorkspaceInfo }) {
	if (entry.type === "note") return <div class="work-note"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>;
	return <WorkRow turnId={turnId} entry={entry} workspace={workspace} />;
}

function WorkRow({ turnId, entry, workspace }: { turnId: string; entry: WorkEntry; workspace?: WorkspaceInfo }) {
	const key = `${turnId}:${entry.id}`;
	const [open, setOpen] = useState(() => workRowOpen.get(key) ?? entry.status === "error");
	useEffect(() => {
		setOpen(workRowOpen.get(key) ?? entry.status === "error");
	}, [key, entry.status]);
	const listing = entry.kind === "list" ? parseDirListing(entry.output) : undefined;
	const fileResults = parseToolFileResults(entry.name, entry.output);
	const webSearch = entry.name === "web_search" ? parseWebSearchOutput(entry.output) : undefined;
	const path = toolPath(entry);
	const directFileAction = entry.type === "tool" && entry.name === "read_file" && entry.status !== "error" && Boolean(path && workspace);
	const hasBody = entry.type === "tool" ? hasToolBody(entry, listing, fileResults, webSearch) : Boolean(entry.output);
	const toggle = () => {
		setOpen((current) => {
			const next = !current;
			workRowOpen.set(key, next);
			return next;
		});
	};
	const summary = (tail?: ComponentChildren) => (
		<>
			<span class={`work-kind ${entry.kind} ${entry.status}${entry.name === "todo_write" ? " plan" : ""}${entry.name === "ask_user_question" ? " ask" : ""}`} aria-hidden="true">{kindIcon(entry.kind, entry.name)}</span>
			<strong>{entry.label}</strong>
			{entry.detail && <span class="work-detail">{entry.detail}</span>}
			{entry.status === "running" ? <LoaderCircle class="work-spin" size={12} strokeWidth={2.4} aria-hidden="true" /> : tail}
		</>
	);
	if (directFileAction && path) {
		return (
			<div class={`work-row ${entry.status}`}>
				<button type="button" class="work-row-toggle work-file-action" onClick={() => openWorkspaceFile(path, workspace)} title={`Open ${path} in editor`}>
					{summary(<ExternalLink class="work-tail-icon" size={12} strokeWidth={2} aria-hidden="true" />)}
				</button>
			</div>
		);
	}
	if (!hasBody) return <div class={`work-row ${entry.status}`}><div class="work-row-toggle">{summary()}</div></div>;
	return (
		<div class={`work-row ${entry.status}${open ? " open" : ""}`}>
			<button type="button" class="work-row-toggle" aria-expanded={open} onClick={toggle}>
				{summary(
					<RotateIcon open={open} class="work-row-chevron">
						<ChevronRight size={12} strokeWidth={2} />
					</RotateIcon>,
				)}
			</button>
			<Collapse open={open}>
				{entry.type === "tool"
					? <ToolBody entry={entry} listing={listing} fileResults={fileResults} webSearch={webSearch} workspace={workspace} />
					: <div class="work-prose"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>}
			</Collapse>
		</div>
	);
}

function ToolBody({ entry, listing, fileResults, webSearch, workspace }: {
	entry: WorkEntry;
	listing: DirEntry[] | undefined;
	fileResults: FileResult[] | undefined;
	webSearch: ReturnType<typeof parseWebSearchOutput>;
	workspace?: WorkspaceInfo;
}) {
	if (entry.status === "error") return <ToolError output={entry.output} />;
	if (entry.kind === "change") return <ChangeBody entry={entry} workspace={workspace} />;
	if (listing) return <DirListing entries={listing} empty={entry.output === "Directory is empty."} basePath={stringArg(entry.args, "path")} workspace={workspace} />;
	if (fileResults) return <FileResults entries={fileResults} workspace={workspace} />;
	if (webSearch) return <WebSearchBody parsed={webSearch} />;
	if (entry.name === "fetch_content") return <div class="work-prose"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>;
	if (entry.name === "todo_write" || entry.name === "ask_user_question") return <pre class="work-body">{entry.output}</pre>;
	if (entry.kind === "terminal") return <TerminalBody output={entry.output} />;
	return <GenericToolBody entry={entry} />;
}

function hasToolBody(
	entry: WorkEntry,
	listing: DirEntry[] | undefined,
	fileResults: FileResult[] | undefined,
	webSearch: ReturnType<typeof parseWebSearchOutput>,
): boolean {
	if (entry.status === "error") return true;
	if (entry.name === "read_file") return false;
	if (entry.name === "todo_write" || entry.name === "ask_user_question") return Boolean(entry.output);
	if (entry.kind === "change") return Boolean(changeInput(entry));
	if (listing || fileResults || webSearch) return true;
	return Boolean(entry.output || (entry.args && Object.keys(entry.args).length));
}

function DirListing({ entries, empty, basePath, workspace }: { entries: DirEntry[]; empty: boolean; basePath?: string; workspace?: WorkspaceInfo }) {
	if (empty || !entries.length) return <div class="dir-list empty">Folder is empty</div>;
	return (
		<ul class="dir-list">
			{entries.map((entry) => (
				<li class={`dir-entry ${entry.kind === "dir" ? "is-folder" : "is-doc"}`} key={`${entry.kind}:${entry.name}`}>
					{entry.kind === "dir"
						? <><Folder size={14} strokeWidth={2} aria-hidden="true" /><span class="dir-name">{entry.name}</span></>
						: <button type="button" class="tool-file-link" onClick={() => openWorkspaceFile(joinPath(basePath, entry.name), workspace)}>
							<File size={14} strokeWidth={2} aria-hidden="true" />
							<span class="dir-name">{entry.name}</span>
							<ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
						</button>}
				</li>
			))}
		</ul>
	);
}

function FileResults({ entries, workspace }: { entries: FileResult[]; workspace?: WorkspaceInfo }) {
	if (!entries.length) return <div class="tool-empty">No matches found</div>;
	return (
		<ul class="file-results">
			{entries.map((entry, index) => (
				<li key={`${entry.path}:${entry.line ?? 0}:${index}`}>
					<button type="button" class="file-result-link" onClick={() => openWorkspaceFile(entry.path, workspace)}>
						<span class="file-result-location"><File size={13} strokeWidth={2} aria-hidden="true" />{entry.path}{entry.line ? <b>:{entry.line}</b> : null}</span>
						{entry.preview && <span class="file-result-preview">{entry.preview}</span>}
						<ExternalLink class="file-result-open" size={11} strokeWidth={2} aria-hidden="true" />
					</button>
				</li>
			))}
		</ul>
	);
}

function ChangeBody({ entry, workspace }: { entry: WorkEntry; workspace?: WorkspaceInfo }) {
	const input = changeInput(entry);
	if (!input) return <GenericToolBody entry={entry} />;
	return (
		<div class="change-card">
			<div class="change-card-head">
				<span>{entry.name === "edit_file" ? "Edit preview" : "Written contents"}</span>
				<button type="button" class="change-open-file" onClick={() => openWorkspaceFile(input.path, workspace)} title={`Open ${input.path} in editor`}>
					<span>{input.path}</span><ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
			<CodeMirrorDiff path={input.path} oldContents={input.oldContents} newContents={input.newContents} />
		</div>
	);
}

function CodeMirrorDiff({ path, oldContents, newContents }: { path: string; oldContents: string; newContents: string }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	useEffect(() => {
		let disposed = false;
		let cleanUp: (() => void) | undefined;
		setState("loading");
		void loadDiffViewRuntime().then((runtime) => {
			if (disposed || !hostRef.current) return;
			cleanUp = runtime.mount(hostRef.current, { path, oldContents, newContents });
			setState("ready");
		}).catch(() => {
			if (!disposed) setState("error");
		});
		return () => {
			disposed = true;
			cleanUp?.();
		};
	}, [path, oldContents, newContents]);
	return (
		<div class={`code-diff ${state}`}>
			{state === "loading" && <div class="diff-status"><LoaderCircle class="work-spin" size={13} strokeWidth={2.4} /> Loading diff…</div>}
			{state === "error" && <div class="diff-status error">Diff preview unavailable</div>}
			<div ref={hostRef} class="code-diff-host" />
		</div>
	);
}

function TerminalBody({ output }: { output?: string }) {
	return <pre class={`terminal-output${output ? "" : " empty"}`}>{output || "Command finished with no output."}</pre>;
}

function ToolError({ output }: { output?: string }) {
	return <ErrorNotice title="Tool failed" message={output || "The tool failed without an error message."} />;
}

function GenericToolBody({ entry }: { entry: WorkEntry }) {
	const hasArgs = Boolean(entry.args && Object.keys(entry.args).length);
	return (
		<div class="work-io generic-tool-io">
			{hasArgs && <pre class="work-input-body">{formatArgs(entry.args ?? {})}</pre>}
			{entry.output && <pre class="work-body">{entry.output}</pre>}
		</div>
	);
}

function WebSearchBody({ parsed }: { parsed: NonNullable<ReturnType<typeof parseWebSearchOutput>> }) {
	return (
		<div class="web-search">
			{parsed.answer && <p class="web-search-answer">{parsed.answer}</p>}
			<ol class="web-sources">
				{parsed.results.map((result) => (
					<li class="web-source" key={result.url}>
						<button type="button" class="web-source-link" onClick={() => void openCustomTab(result.url).catch(() => undefined)}>
							<span class="web-source-title">{result.title}</span>
							<small>{hostOf(result.url)}</small>
						</button>
						{result.snippet && <p>{result.snippet}</p>}
					</li>
				))}
			</ol>
		</div>
	);
}

function changeInput(entry: WorkEntry): { path: string; oldContents: string; newContents: string } | undefined {
	const path = toolPath(entry);
	if (!path) return undefined;
	if (entry.name === "edit_file") {
		const oldContents = stringArg(entry.args, "old_string");
		const newContents = stringArg(entry.args, "new_string");
		if (oldContents === undefined || newContents === undefined) return undefined;
		return { path, oldContents, newContents };
	}
	if (entry.name === "write_file") {
		const newContents = stringArg(entry.args, "content");
		if (newContents === undefined) return undefined;
		return { path, oldContents: "", newContents };
	}
	return undefined;
}

function toolPath(entry: WorkEntry): string | undefined {
	return stringArg(entry.args, "path", "file_path", "filePath", "filename", "target");
}

function stringArg(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function joinPath(base: string | undefined, name: string): string {
	const cleanBase = base?.trim().replace(/^\.\/?$/, "").replace(/\/$/, "") ?? "";
	return cleanBase ? `${cleanBase}/${name}` : name;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function kindIcon(kind: ToolKind, name?: string) {
	const props = { size: 13, strokeWidth: 2 } as const;
	if (name === "todo_write") return <ListPlus {...props} />;
	if (name === "ask_user_question") return <AskIcon />;
	switch (kind) {
		case "read":
			return <Eye {...props} />;
		case "change":
			return <Pencil {...props} />;
		case "search":
			return <Search {...props} />;
		case "web":
			return <Globe {...props} />;
		case "list":
			return <FolderOpen {...props} />;
		case "terminal":
			return <SquareTerminal {...props} />;
		case "think":
			return <Sparkles {...props} />;
		default:
			return <Wrench {...props} />;
	}
}

function AskIcon() {
	return (
		<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			<path d="M9.6 9.6a2.4 2.4 0 1 1 3.3 2.2c-.8.4-1.4 1-1.4 1.8" />
			<path d="M12 17.2h.01" />
		</svg>
	);
}

function formatArgs(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}
