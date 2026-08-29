import { Bot, ChevronLeft, ChevronRight, LoaderCircle, Square, X } from "lucide-preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import { formatElapsed } from "../subagents/format";
import type { SubagentInspect, SubagentRunView, SubagentWorkItem } from "../subagents/types";
import { Sheet } from "./Sheet";

export function FleetBar({
	runs,
	controller,
	open,
	focusId,
	onOpen,
	onClose,
	onToast,
}: {
	runs: SubagentRunView[];
	controller: AgentController;
	open: boolean;
	focusId?: string;
	onOpen: (id?: string) => void;
	onClose: () => void;
	onToast: (message: string) => void;
}) {
	const live = useMemo(() => visibleRuns(runs), [runs]);
	if (!live.length && !open) return null;
	return (
		<>
			{live.length > 0 && (
				<div class="fleet-bar" role="status">
					<button type="button" class="fleet-open" onClick={() => onOpen(live[0]?.id)} aria-label="Open subagents">
						<Bot size={15} strokeWidth={2} aria-hidden="true" />
						<span>{fleetSummary(live)}</span>
					</button>
					<div class="fleet-chips">
						{live.slice(0, 4).map((run) => (
							<button type="button" class={`fleet-chip ${run.status}`} key={run.id} onClick={() => onOpen(run.id)}>
								{run.status === "running" || run.status === "queued"
									? <LoaderCircle class="work-spin" size={12} strokeWidth={2.4} aria-hidden="true" />
									: <i class={`fleet-dot ${run.status}`} />}
								<span>{run.agent}</span>
							</button>
						))}
					</div>
				</div>
			)}
			{open && (
				<FleetSheet
					controller={controller}
					runs={runs}
					focusId={focusId}
					onClose={onClose}
					onToast={onToast}
				/>
			)}
		</>
	);
}

function FleetSheet({
	controller,
	runs,
	focusId,
	onClose,
	onToast,
}: {
	controller: AgentController;
	runs: SubagentRunView[];
	focusId?: string;
	onClose: () => void;
	onToast: (message: string) => void;
}) {
	const [selectedId, setSelectedId] = useState(focusId);
	useEffect(() => {
		if (focusId) setSelectedId(focusId);
	}, [focusId]);
	const selected = selectedId ? runs.find((run) => run.id === selectedId) : undefined;
	return (
		<Sheet class="fleet-sheet" onClose={onClose}>
			{(close) => selected ? (
				<RunDetail
					controller={controller}
					run={selected}
					onBack={() => setSelectedId(undefined)}
					onClose={close}
					onToast={onToast}
				/>
			) : (
				<>
					<div class="sheet-handle" />
					<header class="sheet-header">
						<div>
							<h2>Subagents</h2>
							<small>{runs.length ? `${runs.length} in this session` : "No runs yet"}</small>
						</div>
						<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
					</header>
					<div class="fleet-list">
						{runs.length === 0 ? (
							<p class="fleet-empty">The parent can delegate scout, researcher, reviewer, oracle, worker, or delegate work. Ask in the chat, or wait for a tool call.</p>
						) : (
							[...runs].reverse().map((run) => (
								<button type="button" class={`fleet-row ${run.status}`} key={run.id} onClick={() => setSelectedId(run.id)}>
									<div>
										<b>{run.agent}</b>
										<small>{run.status.replace("_", " ")} · {formatElapsed(run.startedAt, run.endedAt)}</small>
										<span>{run.task}</span>
									</div>
									<ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
								</button>
							))
						)}
					</div>
				</>
			)}
		</Sheet>
	);
}

function RunDetail({
	controller,
	run,
	onBack,
	onClose,
	onToast,
}: {
	controller: AgentController;
	run: SubagentRunView;
	onBack: () => void;
	onClose: () => void;
	onToast: (message: string) => void;
}) {
	const [inspect, setInspect] = useState<SubagentInspect | undefined>();
	const [steer, setSteer] = useState("");
	useEffect(() => {
		try {
			setInspect(controller.inspectSubagent(run.id));
		} catch (error) {
			onToast(error instanceof Error ? error.message : String(error));
		}
	}, [controller, onToast, run.id, run.status, run.toolCount, run.lastTool, run.output]);
	const live = inspect?.run ?? run;
	const work = inspect?.work ?? [];
	const output = inspect?.output || live.output || live.error || "";
	const running = live.status === "running" || live.status === "queued";
	const sendSteer = () => {
		const text = steer.trim();
		if (!text) return;
		void controller.steerSubagent(live.id, text).then(() => {
			setSteer("");
			onToast("Steered");
		}).catch((error) => onToast(error instanceof Error ? error.message : String(error)));
	};
	return (
		<>
			<div class="sheet-handle" />
			<header class="sheet-header with-back">
				<button type="button" class="sheet-back" onClick={onBack} aria-label="Back">
					<ChevronLeft size={20} strokeWidth={2} />
				</button>
				<div>
					<h2>{live.agent}</h2>
					<small>{live.status.replace("_", " ")} · {formatElapsed(live.startedAt, live.endedAt)} · {live.id}</small>
				</div>
				<button type="button" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
			</header>
			<div class="fleet-detail">
				<p class="fleet-task">{live.task}</p>
				{running && (
					<div class="fleet-controls">
						<button type="button" class="fleet-stop" onClick={() => void controller.stopSubagent(live.id).catch((error) => onToast(error instanceof Error ? error.message : String(error)))}>
							<Square size={12} strokeWidth={2} /> Stop
						</button>
					</div>
				)}
				{work.length > 0 && (
					<section class="fleet-work" aria-label="Child tools">
						{work.map((item) => <WorkLine item={item} key={item.id} />)}
					</section>
				)}
				{output && <pre class="fleet-output">{output}</pre>}
				{running && (
					<form class="fleet-steer" onSubmit={(event) => { event.preventDefault(); sendSteer(); }}>
						<input
							value={steer}
							placeholder="Steer this child"
							aria-label="Steer this child"
							onInput={(event) => setSteer(event.currentTarget.value)}
						/>
						<button type="submit" disabled={!steer.trim()}>Send</button>
					</form>
				)}
			</div>
		</>
	);
}

function WorkLine({ item }: { item: SubagentWorkItem }) {
	return (
		<div class={`fleet-work-line ${item.status}`}>
			<strong>{item.label}</strong>
			{item.detail && <span>{item.detail}</span>}
		</div>
	);
}

function visibleRuns(runs: SubagentRunView[]): SubagentRunView[] {
	const active = runs.filter((run) => run.status === "running" || run.status === "queued");
	if (active.length) return active;
	return runs.filter((run) => run.endedAt && Date.now() - run.endedAt < 120_000).slice(-3);
}

function fleetSummary(runs: SubagentRunView[]): string {
	const running = runs.filter((run) => run.status === "running" || run.status === "queued").length;
	if (running === 1) return "1 subagent";
	if (running > 1) return `${running} subagents`;
	if (runs.length === 1) return `${runs[0]!.agent} ${runs[0]!.status.replace("_", " ")}`;
	return `${runs.length} finished`;
}
