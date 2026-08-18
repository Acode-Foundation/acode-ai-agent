import { ChevronDown, Eye, File, Folder, FolderOpen, LoaderCircle, Pencil, Search, Sparkles, Wrench } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Markdown } from "./markdown";
import type { WorkspaceInfo } from "../core/types";
import { formatWorkDuration, groupWorkEntries, parseDirListing, splitReadOutput, turnDurationMs, type ChatTurn, type DirEntry, type ToolKind, type WorkEntry } from "./transcript";

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
					: <WorkBurst key={`burst-${group.entries[0]?.id ?? index}`} turnId={turn.id} entries={group.entries} workspace={workspace} />
			))}
		</div>
	);

	if (turn.streaming) return body;

	return (
		<section class="work-log settled" aria-label="Work log">
			<button type="button" class="work-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
				<span>{duration === undefined ? "Worked" : `Worked for ${formatWorkDuration(duration)}`}</span>
				<ChevronDown class={`work-chevron${expanded ? " open" : ""}`} size={14} strokeWidth={2} aria-hidden="true" />
			</button>
			{expanded && body}
		</section>
	);
}

export function WorkingIndicator({ startedAt }: { startedAt?: number }) {
	const labelRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const started = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now();
		const update = () => {
			if (!labelRef.current) return;
			const seconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
			labelRef.current.textContent = seconds > 0 ? `Working for ${seconds}s` : "Working";
		};
		update();
		const timer = window.setInterval(update, 1_000);
		return () => window.clearInterval(timer);
	}, [startedAt]);
	return (
		<div class="typing" aria-live="polite">
			<span class="work-dots" aria-hidden="true"><i /><i /><i /></span>
			<span ref={labelRef}>Working</span>
		</div>
	);
}

function WorkBurst({ turnId, entries, workspace }: { turnId: string; entries: WorkEntry[]; workspace?: WorkspaceInfo }) {
	const [showPrevious, setShowPrevious] = useState(false);
	const latest = entries[entries.length - 1];
	if (!latest) return null;
	const previous = entries.slice(0, -1);
	return (
		<div class="work-burst">
			<WorkRow turnId={turnId} entry={latest} workspace={workspace} />
			{previous.length > 0 && (
				<button type="button" class="work-more" aria-expanded={showPrevious} onClick={() => setShowPrevious((value) => !value)}>
					<ChevronDown class={showPrevious ? "open" : ""} size={14} strokeWidth={2} aria-hidden="true" />
					<span>{showPrevious ? "Show fewer tool calls" : `+${previous.length} previous tool ${previous.length === 1 ? "call" : "calls"}`}</span>
				</button>
			)}
			{previous.map((entry) => (
				<div key={entry.id} hidden={!showPrevious}>
					<WorkRow turnId={turnId} entry={entry} workspace={workspace} />
				</div>
			))}
		</div>
	);
}

function WorkContent({ turnId, entry, workspace }: { turnId: string; entry: WorkEntry; workspace?: WorkspaceInfo }) {
	if (entry.type === "note") return <div class="work-note"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>;
	return <WorkRow turnId={turnId} entry={entry} workspace={workspace} />;
}

function WorkRow({ turnId, entry, workspace }: { turnId: string; entry: WorkEntry; workspace?: WorkspaceInfo }) {
	const key = `${turnId}:${entry.id}`;
	const [open, setOpen] = useState(() => workRowOpen.get(key) ?? false);
	useEffect(() => {
		setOpen(workRowOpen.get(key) ?? false);
	}, [key]);
	const listing = entry.kind === "list" ? parseDirListing(entry.output) : undefined;
	const hasBody = Boolean(listing?.length || (listing && entry.output === "Directory is empty.") || entry.output || (entry.args && Object.keys(entry.args).length));
	const toggle = () => {
		setOpen((current) => {
			const next = !current;
			workRowOpen.set(key, next);
			return next;
		});
	};
	const summary = (
		<>
			<span class={`work-kind ${entry.kind} ${entry.status}`} aria-hidden="true">{kindIcon(entry.kind)}</span>
			<strong>{entry.label}</strong>
			{entry.detail && <span class="work-detail">{entry.detail}</span>}
			{entry.status === "running" && <LoaderCircle class="work-spin" size={12} strokeWidth={2.4} aria-hidden="true" />}
		</>
	);
	if (!hasBody) return <div class={`work-row ${entry.status}`}><div class="work-row-toggle">{summary}</div></div>;
	return (
		<div class={`work-row ${entry.status}${open ? " open" : ""}`}>
			<button type="button" class="work-row-toggle" aria-expanded={open} onClick={toggle}>
				{summary}
			</button>
			<div hidden={!open}>
				{listing
					? <DirListing entries={listing} empty={entry.output === "Directory is empty."} />
					: entry.type === "thinking"
						? <div class="work-prose"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>
						: entry.kind === "read"
							? <ReadBody output={entry.output ?? ""} fallback={formatArgs(entry.args ?? {})} />
							: <pre class="work-body">{entry.output ?? formatArgs(entry.args ?? {})}</pre>}
			</div>
		</div>
	);
}

function ReadBody({ output, fallback }: { output: string; fallback: string }) {
	const { body, notice } = splitReadOutput(output);
	return (
		<>
			{notice && <div class="work-read-note">{notice}</div>}
			<pre class="work-body">{body || fallback}</pre>
		</>
	);
}

function DirListing({ entries, empty }: { entries: DirEntry[]; empty: boolean }) {
	if (empty || !entries.length) return <div class="dir-list empty">Folder is empty</div>;
	return (
		<ul class="dir-list">
			{entries.map((entry) => (
				<li class={`dir-entry ${entry.kind === "dir" ? "is-folder" : "is-doc"}`} key={`${entry.kind}:${entry.name}`}>
					{entry.kind === "dir" ? <Folder size={14} strokeWidth={2} aria-hidden="true" /> : <File size={14} strokeWidth={2} aria-hidden="true" />}
					<span class="dir-name">{entry.name}</span>
				</li>
			))}
		</ul>
	);
}

function kindIcon(kind: ToolKind) {
	const props = { size: 13, strokeWidth: 2 } as const;
	switch (kind) {
		case "read":
			return <Eye {...props} />;
		case "change":
			return <Pencil {...props} />;
		case "search":
			return <Search {...props} />;
		case "list":
			return <FolderOpen {...props} />;
		case "think":
			return <Sparkles {...props} />;
		default:
			return <Wrench {...props} />;
	}
}

function formatArgs(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}
