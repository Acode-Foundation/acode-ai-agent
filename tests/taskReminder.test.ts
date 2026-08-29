import { expect, test } from "vitest";
import {
	ACTIVE_REMINDER_INTERVAL,
	AUTO_CLEAR_DELAY_TURNS,
	buildTaskReminder,
	createCadenceState,
	drainReminder,
	evaluateReminder,
	markStaleInProgress,
	noteResolvedBoundary,
	onTurnStart,
	REMINDER_INTERVAL,
	shouldAutoClear,
} from "../src/tasks/reminder.ts";
import { TaskList } from "../src/tasks/taskList.ts";
import { TASK_TOOL_NAME } from "../src/tasks/types.ts";

function listWith(status: "pending" | "in_progress" | "completed") {
	const tasks = new TaskList();
	tasks.replace([{ content: "Work", status }]);
	return tasks.list();
}

test("does not inject a reminder until the idle interval has passed", () => {
	const state = createCadenceState();
	const tasks = listWith("pending");
	onTurnStart(state);
	evaluateReminder(state, TASK_TOOL_NAME, tasks);
	expect(drainReminder(state)).toBe(false);

	for (let turn = 0; turn < REMINDER_INTERVAL; turn += 1) {
		onTurnStart(state);
		evaluateReminder(state, "read_file", tasks);
	}
	expect(state.reminderDue).toBe(true);
	expect(drainReminder(state)).toBe(true);
	expect(drainReminder(state)).toBe(false);
});

test("uses a shorter interval while a task is in progress", () => {
	const state = createCadenceState();
	const tasks = listWith("in_progress");
	onTurnStart(state);
	evaluateReminder(state, TASK_TOOL_NAME, tasks);
	onTurnStart(state);
	evaluateReminder(state, "grep", tasks);
	expect(state.reminderDue).toBe(false);
	onTurnStart(state);
	evaluateReminder(state, "grep", tasks);
	expect(state.currentTurn - state.lastTaskToolUseTurn).toBe(ACTIVE_REMINDER_INTERVAL);
	expect(state.reminderDue).toBe(true);
});

test("marks a reminder due when in_progress work is left after a text-only gap", () => {
	const state = createCadenceState();
	const tasks = listWith("in_progress");
	onTurnStart(state);
	evaluateReminder(state, TASK_TOOL_NAME, tasks);
	onTurnStart(state);
	onTurnStart(state);
	markStaleInProgress(state, tasks);
	expect(state.reminderDue).toBe(true);
});

test("never reminds about an empty list", () => {
	const state = createCadenceState();
	onTurnStart(state);
	evaluateReminder(state, "read_file", []);
	onTurnStart(state);
	onTurnStart(state);
	onTurnStart(state);
	onTurnStart(state);
	evaluateReminder(state, "read_file", []);
	expect(state.reminderDue).toBe(false);
	expect(buildTaskReminder([])).toBe("");
});

test("echoes unfinished tasks as compact JSON and never mentions itself as chat", () => {
	const tasks = new TaskList();
	tasks.replace([
		{ content: "One", status: "completed" },
		{ content: "Two", status: "in_progress", activeForm: "Doing two" },
		{ content: "Three\nwith\nnewlines", status: "pending" },
	]);
	const reminder = buildTaskReminder(tasks.list());
	expect(reminder.startsWith("<system-reminder>")).toBe(true);
	expect(reminder).toContain("DO NOT mention this reminder");
	expect(reminder).toContain(TASK_TOOL_NAME);
	expect(reminder).toContain('"Doing two"');
	expect(reminder).not.toContain("\nwith\n");
	expect(reminder).not.toContain("</system-reminder>\nThree");
});

test("auto-clears a fully resolved list after the delay", () => {
	const state = createCadenceState();
	const tasks = listWith("completed");
	onTurnStart(state);
	noteResolvedBoundary(state, tasks);
	expect(shouldAutoClear(state, tasks)).toBe(false);
	for (let turn = 0; turn < AUTO_CLEAR_DELAY_TURNS; turn += 1) onTurnStart(state);
	noteResolvedBoundary(state, tasks);
	expect(shouldAutoClear(state, tasks)).toBe(true);
	expect(shouldAutoClear(state, [])).toBe(false);
	expect(shouldAutoClear(state, listWith("pending"))).toBe(false);
});
