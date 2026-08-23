import { Copy, LocateFixed, Search, Sparkles, X } from "lucide-preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import type { SessionTreeItem } from "../core/types";
import { pickAcodeSelect } from "../platform/acodeSelect";
import { Sheet } from "./Sheet";
import { countTreeBranches, layoutSessionTree, treeGutterText, treeKindLabel, type TreeFilter, type TreeRow } from "./sessionTree";

type Mode = "tree" | "fork";

export function TreeSheet({
	controller,
	mode,
	onClose,
	onError,
	onRestorePrompt,
}: {
	controller: AgentController;
	mode: Mode;
	onClose: () => void;
	onError: (message: string) => void;
	onRestorePrompt: (text: string) => void;
}) {
	const [items, setItems] = useState<SessionTreeItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState<TreeFilter>(mode === "fork" ? "user" : "messages");
	const [query, setQuery] = useState("");
	const [folded, setFolded] = useState<string[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const centerNext = useRef(true);

	useEffect(() => {
		let live = true;
		void controller.getTreeItems().then((next) => {
			if (!live) return;
			setItems(next);
			setSelectedId(initialSelection(next, mode)?.id ?? null);
		}).catch((error) => onError(String(error))).finally(() => {
			if (live) setLoading(false);
		});
		return () => { live = false; };
	}, [controller, mode, onError]);

	const rows = useMemo(
		() => layoutSessionTree(items, { filter: mode === "fork" ? "user" : filter, query, folded }),
		[items, mode, filter, query, folded],
	);
	const selected = rows.find((row) => row.id === selectedId) ?? items.find((item) => item.id === selectedId);
	const selectedIndex = rows.findIndex((row) => row.id === selectedId);
	const branches = useMemo(() => countTreeBranches(items), [items]);
	const turns = useMemo(
		() => items.filter((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "summary").length,
		[items],
	);

	useEffect(() => {
		if (!rows.length || rows.some((row) => row.id === selectedId)) return;
		setSelectedId(rows.find((row) => row.current)?.id ?? [...rows].reverse().find((row) => row.active)?.id ?? rows[0]!.id);
	}, [rows, selectedId]);

	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list || !selectedId || loading) return;
		const row = list.querySelector(`[data-tree-id="${cssEscape(selectedId)}"]`);
		if (!(row instanceof HTMLElement)) return;
		row.scrollIntoView({ block: centerNext.current ? "center" : "nearest" });
		centerNext.current = false;
	}, [loading, rows, selectedId]);

	const jumpToCurrent = () => {
		const current = rows.find((row) => row.current) ?? items.find((item) => item.current);
		if (!current) return;
		centerNext.current = true;
		if (selectedId === current.id) {
			const row = listRef.current?.querySelector(`[data-tree-id="${cssEscape(current.id)}"]`);
			if (row instanceof HTMLElement) row.scrollIntoView({ block: "center" });
			centerNext.current = false;
			return;
		}
		setSelectedId(current.id);
	};

	const toggleFold = (id: string) => {
		setFolded((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
	};

	const navigate = (options: { summarize?: boolean; customInstructions?: string }, close: () => void) => {
		if (!selected || selected.current || busy) return;
		setBusy(true);
		void controller.navigateTree(selected.id, options).then((text) => {
			close();
			if (text) onRestorePrompt(text);
		}).catch((error) => {
			onError(error instanceof Error ? error.message : String(error));
			setBusy(false);
		});
	};

	const summarizeAndNavigate = (close: () => void) => {
		if (!selected || selected.current || busy) return;
		void pickAcodeSelect("Branch summary", [
			{ value: "default", text: "Summarize abandoned branch" },
			{ value: "custom", text: "Summarize with custom focus" },
		], "default").then(async (choice) => {
			if (!choice) return;
			if (choice === "default") {
				navigate({ summarize: true }, close);
				return;
			}
			const instructions = await acode.prompt("Summary focus", "", "textarea", { placeholder: "What should the branch summary preserve?" });
			if (instructions?.trim()) navigate({ summarize: true, customInstructions: instructions.trim() }, close);
		}).catch((error) => onError(error instanceof Error ? error.message : String(error)));
	};

	const fork = (close: () => void) => {
		if (!selected || selected.kind !== "user" || busy) return;
		setBusy(true);
		void controller.forkConversation(selected.id).then((text) => {
			close();
			if (text) onRestorePrompt(text);
		}).catch((error) => {
			onError(error instanceof Error ? error.message : String(error));
			setBusy(false);
		});
	};

	const copySelected = () => {
		const text = selected?.text.trim();
		if (!text) return;
		void navigator.clipboard.writeText(text).then(() => onError("Copied")).catch((error) => onError(error instanceof Error ? error.message : String(error)));
	};

	const confirmRow = (row: TreeRow, close: () => void) => {
		if (mode === "fork") {
			if (row.kind === "user") fork(close);
			return;
		}
		if (!row.current) navigate({ summarize: false }, close);
	};

	const canGo = Boolean(selected) && !selected?.current && !busy && (mode !== "fork" || selected?.kind === "user");
	const primaryLabel = busy
		? (mode === "fork" ? "Forking…" : "Moving…")
		: selected?.current
			? "Here"
			: mode === "fork"
				? "Fork here"
				: selected?.kind === "user"
					? "Retry"
					: "Go here";

	return (
		<Sheet class="tree-sheet" onClose={onClose}>
			{(close) => (
				<>
					<div class="sheet-handle" />
					<header class="sheet-header">
						<div>
							<h2>{mode === "fork" ? "Fork session" : "Session tree"}</h2>
							<small>
								{loading
									? "Loading session…"
									: mode === "fork"
										? "Pick a prompt to continue in a new session"
										: treeSummary(turns, branches, rows.length)}
							</small>
						</div>
						<div class="sheet-header-actions">
							{mode === "tree" && (
								<button type="button" onClick={jumpToCurrent} aria-label="Jump to current leaf">
									<LocateFixed size={16} strokeWidth={2} />
								</button>
							)}
							<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
						</div>
					</header>
					<div class="tree-controls">
						<label class="tree-search">
							<Search size={16} strokeWidth={2} />
							<input
								type="search"
								value={query}
								placeholder={mode === "fork" ? "Search prompts" : "Search this tree"}
								enterKeyHint="search"
								autoCapitalize="none"
								autoCorrect="off"
								onInput={(event) => setQuery(event.currentTarget.value)}
							/>
						</label>
						{mode === "tree" && (
							<div class="tree-filters" role="tablist" aria-label="Tree filter">
								{FILTERS.map((option) => (
									<button
										type="button"
										role="tab"
										aria-selected={filter === option.value}
										class={filter === option.value ? "selected" : ""}
										onClick={() => setFilter(option.value)}
										key={option.value}
									>
										{option.label}
									</button>
								))}
							</div>
						)}
					</div>
					<div class="tree-list" ref={listRef} role="listbox" aria-label="Session tree">
						{loading ? (
							<p class="sheet-empty">Loading session…</p>
						) : rows.length === 0 ? (
							<p class="sheet-empty">{query.trim() ? "No turns match that search." : "No tree entries match."}</p>
						) : rows.map((row, index) => {
							const gutter = treeGutterText(row);
							const isSelected = selectedId === row.id;
							const spineStart = row.active && !rows[index - 1]?.active;
							const spineEnd = row.active && !rows[index + 1]?.active;
							return (
								<div
									class={`tree-row${row.active ? " active-path" : " off-path"}${row.current ? " current" : ""}${isSelected ? " selected" : ""}`}
									data-tree-id={row.id}
									role="option"
									aria-selected={isSelected}
									tabIndex={0}
									key={row.id}
									onClick={() => {
										if (isSelected) confirmRow(row, close);
										else setSelectedId(row.id);
									}}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											if (isSelected) confirmRow(row, close);
											else setSelectedId(row.id);
										}
									}}
								>
									<span class="tree-caret" aria-hidden="true">{isSelected ? "›" : ""}</span>
									{row.foldable ? (
										<button
											type="button"
											class="tree-gutter"
											aria-label={row.folded ? "Expand branch" : "Collapse branch"}
											onClick={(event) => {
												event.stopPropagation();
												toggleFold(row.id);
											}}
										>
											{gutter}
										</button>
									) : (
										<span class="tree-gutter" aria-hidden="true">{gutter}</span>
									)}
									<i
										class={`tree-dot${row.active ? " on" : " off"}${row.current ? " here" : ""}${spineStart ? " start" : ""}${spineEnd ? " end" : ""}`}
										aria-hidden="true"
									/>
									<span class="tree-main">
										<span class="tree-entry-text">
											<b class={`tree-role ${row.kind}`}>{treeKindLabel(row.kind)}:</b>
											{row.label ? ` [${row.label}] ${row.text}` : ` ${row.text}`}
										</span>
									</span>
									{row.current ? <em class="tree-now">now</em> : isSelected ? <time>{formatTreeTime(row.timestamp)}</time> : null}
								</div>
							);
						})}
					</div>
					<footer class="tree-actions">
						<div class="tree-actions-meta">
							{selected ? (
								<>
									<p class="tree-preview">{selected.label ? `[${selected.label}] ${selected.text}` : selected.text}</p>
									<small>
										{selectedIndex >= 0 ? `${selectedIndex + 1} of ${rows.length}` : "Selected"}
										{" · "}
										{selected.current ? "Current leaf" : selected.kind === "user" && mode === "tree" ? "Retry this prompt on a new branch" : mode === "fork" ? "New session from this prompt" : "Continue from this point"}
									</small>
								</>
							) : (
								<small>Select a turn</small>
							)}
						</div>
						<div class={`tree-action-buttons${mode === "fork" ? " fork" : ""}`}>
							<button type="button" class="tree-icon-action" disabled={!selected?.text.trim() || busy} onClick={copySelected} aria-label="Copy selected text">
								<Copy size={16} strokeWidth={2} />
							</button>
							{mode === "fork" ? (
								<button class="primary" type="button" disabled={!canGo} onClick={() => fork(close)}>{primaryLabel}</button>
							) : (
								<>
									<button type="button" disabled={!canGo} onClick={() => summarizeAndNavigate(close)}>
										<Sparkles size={14} strokeWidth={2} />
										Summarize
									</button>
									<button class="primary" type="button" disabled={!canGo} onClick={() => navigate({ summarize: false }, close)}>{primaryLabel}</button>
								</>
							)}
						</div>
					</footer>
				</>
			)}
		</Sheet>
	);
}

const FILTERS: Array<{ value: TreeFilter; label: string }> = [
	{ value: "messages", label: "Turns" },
	{ value: "user", label: "You" },
	{ value: "all", label: "All" },
];

function initialSelection(items: SessionTreeItem[], mode: Mode): SessionTreeItem | undefined {
	if (mode === "fork") return [...items].reverse().find((item) => item.kind === "user" && item.active);
	return items.find((item) => item.current && (item.kind === "user" || item.kind === "assistant" || item.kind === "summary"))
		?? [...items].reverse().find((item) => item.active && (item.kind === "user" || item.kind === "assistant" || item.kind === "summary"));
}

function treeSummary(turns: number, branches: number, visible: number): string {
	const turnLabel = `${turns} ${turns === 1 ? "turn" : "turns"}`;
	const branchLabel = branches > 0 ? ` · ${branches} ${branches === 1 ? "branch" : "branches"}` : "";
	const hidden = visible !== turns && turns > 0 ? ` · ${visible} shown` : "";
	return `${turnLabel}${branchLabel}${hidden}`;
}

function formatTreeTime(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "";
	const now = new Date();
	if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
		return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function cssEscape(value: string): string {
	return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/"/g, "\\22");
}
