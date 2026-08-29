import { isBlocked } from "./taskList";
import { isResolvedStatus, TASK_TOOL_NAME, type Task } from "./types";

export const REMINDER_INTERVAL = 4;
export const ACTIVE_REMINDER_INTERVAL = 2;
export const REMINDER_MAX_TASKS = 10;
export const AUTO_CLEAR_DELAY_TURNS = 4;

export type CadenceState = {
	currentTurn: number;
	lastTaskToolUseTurn: number;
	reminderInjectedThisCycle: boolean;
	reminderDue: boolean;
	allResolvedTurn?: number;
};

export function createCadenceState(): CadenceState {
	return {
		currentTurn: 0,
		lastTaskToolUseTurn: 0,
		reminderInjectedThisCycle: false,
		reminderDue: false,
	};
}

export function resetCadenceState(state: CadenceState): void {
	state.currentTurn = 0;
	state.lastTaskToolUseTurn = 0;
	state.reminderInjectedThisCycle = false;
	state.reminderDue = false;
	state.allResolvedTurn = undefined;
}

export function onTurnStart(state: CadenceState): void {
	state.currentTurn += 1;
	state.reminderInjectedThisCycle = false;
}

export function noteTaskToolUse(state: CadenceState): void {
	state.lastTaskToolUseTurn = state.currentTurn;
	state.reminderDue = false;
	state.reminderInjectedThisCycle = false;
}

export function noteResolvedBoundary(state: CadenceState, tasks: readonly Task[]): void {
	if (tasks.length > 0 && tasks.every((task) => isResolvedStatus(task.status))) {
		state.allResolvedTurn ??= state.currentTurn;
		return;
	}
	state.allResolvedTurn = undefined;
}

export function shouldAutoClear(state: CadenceState, tasks: readonly Task[]): boolean {
	if (tasks.length === 0) return false;
	if (!tasks.every((task) => isResolvedStatus(task.status))) return false;
	if (state.allResolvedTurn !== undefined && state.currentTurn - state.allResolvedTurn >= AUTO_CLEAR_DELAY_TURNS) return true;
	return false;
}

export function evaluateReminder(state: CadenceState, toolName: string, tasks: readonly Task[]): void {
	if (toolName === TASK_TOOL_NAME) {
		noteTaskToolUse(state);
		return;
	}
	if (state.reminderInjectedThisCycle || state.reminderDue) return;
	const interval = tasks.some((task) => task.status === "in_progress") ? ACTIVE_REMINDER_INTERVAL : REMINDER_INTERVAL;
	if (state.currentTurn - state.lastTaskToolUseTurn < interval) return;
	if (tasks.length === 0) return;
	state.reminderDue = true;
}

export function markStaleInProgress(state: CadenceState, tasks: readonly Task[]): void {
	if (state.reminderInjectedThisCycle || state.reminderDue) return;
	if (state.currentTurn - state.lastTaskToolUseTurn < ACTIVE_REMINDER_INTERVAL) return;
	if (!tasks.some((task) => task.status === "in_progress")) return;
	state.reminderDue = true;
}

export function drainReminder(state: CadenceState): boolean {
	if (!state.reminderDue) return false;
	state.reminderDue = false;
	state.reminderInjectedThisCycle = true;
	state.lastTaskToolUseTurn = state.currentTurn;
	return true;
}

export function buildTaskReminder(tasks: readonly Task[]): string {
	if (tasks.length === 0) return "";
	const shown = selectReminderTasks(tasks);
	const hidden = tasks.length - shown.length;
	const items = shown.map((task) => {
		const item: Record<string, string> = { id: task.id, content: sanitizeField(task.subject), status: reminderStatus(task, tasks) };
		if (task.activeForm) item.activeForm = sanitizeField(task.activeForm);
		return item;
	});
	const overflow = hidden > 0 ? ` (${hidden} more omitted)` : "";
	return [
		"<system-reminder>",
		`Task list is stale. DO NOT mention this reminder. Current tasks:`,
		"",
		`${JSON.stringify(items)}.${overflow} Continue unfinished work with ${TASK_TOOL_NAME}. Do not paste this list into chat.`,
		"</system-reminder>",
	].join("\n");
}

function selectReminderTasks(tasks: readonly Task[]): Task[] {
	if (tasks.length <= REMINDER_MAX_TASKS) return [...tasks];
	return [...tasks]
		.sort((left, right) => reminderRank(left, tasks) - reminderRank(right, tasks) || Number(left.id) - Number(right.id))
		.slice(0, REMINDER_MAX_TASKS);
}

function reminderRank(task: Task, tasks: readonly Task[]): number {
	if (task.status === "in_progress") return 0;
	if (isBlocked(task, tasks)) return 2;
	if (task.status === "pending") return 1;
	return 3;
}

function reminderStatus(task: Task, tasks: readonly Task[]): string {
	return isBlocked(task, tasks) ? "blocked" : task.status;
}

function sanitizeField(value: string): string {
	return value.replace(/[\r\n]+/g, " ").replace(/<\/?system-reminder>/gi, "").trim();
}
