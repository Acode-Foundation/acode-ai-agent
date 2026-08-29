import { Check, LoaderCircle, Trash2, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentController } from "../app/agentController";
import { activeTask, isBlocked, openBlockers, summarizeTasks, taskCounts } from "../tasks/taskList";
import type { Task, TaskStatus } from "../tasks/types";
import { Collapse } from "./Collapse";
import { fadeSlide } from "./motion";
import { Sheet } from "./Sheet";
import { formatWorkDuration } from "./transcript";

export function TaskTray({
	tasks,
	running,
	onOpen,
	onDismiss,
}: {
	tasks: Task[];
	running: boolean;
	onOpen: () => void;
	onDismiss: () => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const counts = taskCounts(tasks);
	const current = activeTask(tasks);
	const next = tasks.find((task) => task.status === "pending" && !isBlocked(task, tasks));
	const label = current
		? current.activeForm || current.subject
		: counts.resolved === counts.total
			? counts.skipped === counts.total
				? "All tasks skipped"
				: "All tasks done"
			: next?.subject ?? summarizeTasks(tasks);
	const ratio = counts.total === 0 ? 0 : counts.resolved / counts.total;
	const mark = current ? "in_progress" : counts.resolved === counts.total ? "completed" : "pending";

	const dismiss = (event: Event) => {
		event.stopPropagation();
		const element = root.current;
		if (!element) {
			onDismiss();
			return;
		}
		void fadeSlide(element, false).then(onDismiss);
	};

	return (
		<div class="task-tray" ref={root}>
			<span class="task-tray-bar" aria-hidden="true">
				<i style={{ transform: `scaleX(${ratio})` }} />
			</span>
			<button type="button" class="task-tray-hit" onClick={onOpen} aria-label={`Tasks, ${counts.resolved} of ${counts.total} done. ${label}`}>
				<span class="task-tray-copy">
					<TaskMark status={mark} />
					<strong class={current && running ? "live" : undefined}>{label}</strong>
					{current?.startedAt && running ? <Elapsed since={current.startedAt} /> : null}
				</span>
				<span class="task-tray-count">{counts.resolved}/{counts.total}</span>
			</button>
			<button type="button" class="task-tray-close" onClick={dismiss} aria-label="Hide tasks">
				<X size={14} strokeWidth={2} />
			</button>
		</div>
	);
}

export function TaskSheet({
	controller,
	tasks,
	onClose,
	onToast,
}: {
	controller: AgentController;
	tasks: Task[];
	onClose: () => void;
	onToast: (message: string) => void;
}) {
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);
	const counts = taskCounts(tasks);
	const fail = (error: unknown) => onToast(error instanceof Error ? error.message : String(error));

	return (
		<Sheet class="tasks" onClose={onClose}>
			{(close) => (
				<>
					<div class="sheet-handle" />
					<header class="sheet-header">
						<div>
							<h2>Tasks</h2>
							<small>{tasks.length ? summarizeTasks(tasks) : "No tasks in this session"}</small>
						</div>
						<div class="sheet-header-actions">
							{counts.resolved > 0 && (
								<button
									type="button"
									aria-label={`Clear ${counts.resolved} finished`}
									onClick={() => {
										setConfirmClear(false);
										const removed = controller.clearCompletedTasks();
										if (removed) onToast(`Cleared ${removed} finished task${removed === 1 ? "" : "s"}.`);
									}}
								>
									<Check size={16} strokeWidth={2} />
								</button>
							)}
							{tasks.length > 0 && (
								<button
									type="button"
									class={confirmClear ? "danger" : undefined}
									aria-label={confirmClear ? "Confirm clear all" : "Clear all tasks"}
									onClick={() => {
										if (!confirmClear) {
											setConfirmClear(true);
											return;
										}
										controller.clearAllTasks();
										setConfirmClear(false);
										onToast("Cleared all tasks.");
									}}
								>
									<Trash2 size={16} strokeWidth={2} />
								</button>
							)}
							<button type="button" onClick={close} aria-label="Close"><X size={16} strokeWidth={2} /></button>
						</div>
					</header>
					<div class="task-sheet-body">
						{tasks.length === 0 ? (
							<p class="task-empty">The agent keeps a checklist here for multi-step work.</p>
						) : (
							<ul class="task-list">
								{tasks.map((task) => (
									<TaskRow
										key={task.id}
										task={task}
										tasks={tasks}
										open={expandedId === task.id}
										onToggle={() => {
											setConfirmClear(false);
											setExpandedId((current) => current === task.id ? null : task.id);
										}}
										onStatus={(status) => {
											setConfirmClear(false);
											void controller.updateTaskStatus(task.id, status).catch(fail);
										}}
									/>
								))}
							</ul>
						)}
					</div>
				</>
			)}
		</Sheet>
	);
}

function TaskRow({
	task,
	tasks,
	open,
	onToggle,
	onStatus,
}: {
	task: Task;
	tasks: Task[];
	open: boolean;
	onToggle: () => void;
	onStatus: (status: TaskStatus | "deleted") => void;
}) {
	const blocked = isBlocked(task, tasks);
	const blockers = openBlockers(task, tasks);
	const status = blocked ? "blocked" : task.status;
	const completed = task.status === "completed";
	return (
		<li class={`task-item ${status}${open ? " open" : ""}`}>
			<div class="task-item-main">
				<button
					type="button"
					class={`task-mark-hit ${status}`}
					aria-label={completed ? `Mark ${task.subject} pending` : `Complete ${task.subject}`}
					onClick={() => onStatus(completed ? "pending" : "completed")}
				>
					<TaskMark status={status} />
				</button>
				<button type="button" class="task-item-copy" onClick={onToggle} aria-expanded={open}>
					<strong>{task.subject}</strong>
					<small>
						{blocked ? `Blocked by ${blockers.map((id) => `#${id}`).join(", ")}` : statusLabel(task.status)}
						{task.status === "in_progress" && task.startedAt ? " · " : ""}
						{task.status === "in_progress" && task.startedAt ? <Elapsed since={task.startedAt} /> : null}
					</small>
				</button>
			</div>
			<Collapse open={open}>
				<div class="task-item-actions">
					{task.status !== "skipped" && task.status !== "completed" && (
						<button type="button" aria-label="Skip" onClick={() => onStatus("skipped")}><SkipIcon /></button>
					)}
					<button type="button" class="danger" aria-label="Delete" onClick={() => onStatus("deleted")}>
						<Trash2 size={15} strokeWidth={2} />
					</button>
				</div>
			</Collapse>
		</li>
	);
}

function TaskMark({ status }: { status: string }) {
	if (status === "completed") return <Check class="task-mark completed" size={16} strokeWidth={2.4} aria-hidden="true" />;
	if (status === "in_progress") return <LoaderCircle class="task-mark in_progress" size={16} strokeWidth={2.4} aria-hidden="true" />;
	if (status === "skipped") return <SkipIcon className="task-mark skipped" />;
	return <PendingIcon className={`task-mark ${status === "blocked" ? "blocked" : "pending"}`} />;
}

function PendingIcon({ className }: { className: string }) {
	return (
		<svg class={className} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
		</svg>
	);
}

function SkipIcon({ className }: { className?: string }) {
	return (
		<svg class={className} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
			<path d="M5 12h14" />
		</svg>
	);
}

function statusLabel(status: TaskStatus): string {
	if (status === "in_progress") return "In progress";
	if (status === "completed") return "Done";
	if (status === "skipped") return "Skipped";
	return "Pending";
}

function Elapsed({ since }: { since: number }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const update = () => {
			if (!ref.current) return;
			const duration = Date.now() - since;
			ref.current.textContent = duration < 1_000 ? "now" : formatWorkDuration(duration);
		};
		update();
		const timer = window.setInterval(update, 1_000);
		return () => window.clearInterval(timer);
	}, [since]);
	return <span ref={ref} class="task-elapsed" />;
}

export function taskStatusLine(tasks: Task[]): string | undefined {
	const current = activeTask(tasks);
	if (!current) return undefined;
	return current.activeForm || current.subject;
}
