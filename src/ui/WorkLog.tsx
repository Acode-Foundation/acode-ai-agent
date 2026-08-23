import { ChevronDown, ChevronRight, Eye, File, Folder, FolderOpen, Globe, LoaderCircle, Pencil, Search, Sparkles, SquareTerminal, Wrench } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Collapse, RotateIcon } from "./Collapse";
import { Markdown } from "./markdown";
import type { WorkspaceInfo } from "../core/types";
import { openCustomTab } from "../platform/authTab";
import { parseWebSearchOutput } from "../tools/web/format";
import { formatWorkDuration, groupWorkEntries, parseDirListing, splitReadOutput, splitWorkBurst, turnDurationMs, type ChatTurn, type DirEntry, type ToolKind, type WorkEntry } from "./transcript";

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

export function WorkingIndicator({ startedAt }: { startedAt?: number }) {
	const labelRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const started = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now();
		const update = () => {
			if (!labelRef.current) return;
			const seconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
			labelRef.current.textContent = seconds > 0 ? `Working for ${formatWorkDuration(seconds * 1_000)}` : "Working";
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
	const [open, setOpen] = useState(() => workRowOpen.get(key) ?? false);
	useEffect(() => {
		setOpen(workRowOpen.get(key) ?? false);
	}, [key]);
	const listing = entry.kind === "list" ? parseDirListing(entry.output) : undefined;
	const webSearch = entry.name === "web_search" ? parseWebSearchOutput(entry.output) : undefined;
	const hasBody = Boolean(listing?.length || (listing && entry.output === "Directory is empty.") || webSearch?.results.length || entry.output || (entry.args && Object.keys(entry.args).length));
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
			<Collapse open={open}>
				{listing
					? <DirListing entries={listing} empty={entry.output === "Directory is empty."} />
					: webSearch?.results.length
						? <WebSearchBody parsed={webSearch} />
						: entry.type === "thinking"
							? <div class="work-prose"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>
							: entry.kind === "read"
								? <ReadBody output={entry.output ?? ""} fallback={formatArgs(entry.args ?? {})} />
								: entry.name === "fetch_content"
									? <div class="work-prose"><Markdown text={entry.output ?? ""} workspace={workspace} /></div>
									: <pre class="work-body">{entry.output ?? formatArgs(entry.args ?? {})}</pre>}
			</Collapse>
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

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
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

function formatArgs(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}
