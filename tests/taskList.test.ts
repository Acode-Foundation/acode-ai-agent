import { expect, test } from "vitest";
import {
	formatTaskList,
	isBlocked,
	openBlockers,
	parseTaskStore,
	summarizeTasks,
	TaskList,
	taskCounts,
} from "../src/tasks/taskList.ts";

test("assigns stable ids by index when the model omits them", () => {
	const list = new TaskList();
	list.replace([
		{ content: "Inspect auth", status: "pending" },
		{ content: "Write handler", status: "pending" },
	]);
	const first = list.list();
	expect(first.map((task) => task.id)).toEqual(["1", "2"]);

	list.replace([
		{ content: "Inspect auth", status: "completed" },
		{ content: "Write handler", status: "in_progress", activeForm: "Writing handler" },
		{ content: "Add tests", status: "pending", blockedBy: ["2"] },
	]);
	const next = list.list();
	expect(next.map((task) => task.id)).toEqual(["1", "2", "3"]);
	expect(next[0]?.status).toBe("completed");
	expect(next[1]?.status).toBe("in_progress");
	expect(next[1]?.activeForm).toBe("Writing handler");
	expect(openBlockers(next[2]!, next)).toEqual(["2"]);
});

test("keeps ids when the model sends them, including a leading hash", () => {
	const list = new TaskList();
	list.replace([{ id: "#4", content: "Later work", status: "pending" }]);
	expect(list.list()[0]?.id).toBe("4");
	list.replace([{ id: "4", content: "Later work", status: "completed" }]);
	expect(list.list()).toHaveLength(1);
	expect(list.list()[0]?.id).toBe("4");
});

test("demotes extra in_progress tasks and blocked in_progress work", () => {
	const list = new TaskList();
	const result = list.replace([
		{ content: "First", status: "in_progress" },
		{ content: "Second", status: "in_progress" },
		{ content: "Third", status: "in_progress", blockedBy: ["1"] },
	]);
	const tasks = list.list();
	expect(tasks.filter((task) => task.status === "in_progress")).toHaveLength(1);
	expect(tasks[0]?.status).toBe("in_progress");
	expect(tasks[1]?.status).toBe("pending");
	expect(tasks[2]?.status).toBe("pending");
	expect(result.warnings.some((warning) => warning.includes("demoted #2"))).toBe(true);
	expect(result.warnings.some((warning) => warning.includes("blocked by #1"))).toBe(true);
});

test("caps the list and ignores empty content", () => {
	const list = new TaskList();
	const drafts = Array.from({ length: 22 }, (_, index) => ({ content: `Task ${index + 1}`, status: "pending" as const }));
	drafts[1] = { content: "   ", status: "pending" };
	const result = list.replace(drafts);
	expect(list.list()).toHaveLength(19);
	expect(result.warnings.some((warning) => warning.includes("Kept 20"))).toBe(true);
	expect(result.warnings.some((warning) => warning.includes("empty"))).toBe(true);
});

test("starts a new batch after a finished list instead of appending to it", () => {
	const list = new TaskList();
	list.replace([
		{ content: "Old one", status: "completed" },
		{ content: "Old two", status: "skipped" },
	]);
	list.replace([{ content: "New work", status: "pending" }]);
	expect(list.list().map((task) => ({ id: task.id, subject: task.subject }))).toEqual([
		{ id: "3", subject: "New work" },
	]);
});

test("empty write clears the list", () => {
	const list = new TaskList();
	list.replace([{ content: "A", status: "pending" }]);
	list.replace([]);
	expect(list.list()).toEqual([]);
});

test("user status updates and deletion clean blocker edges", () => {
	const list = new TaskList();
	list.replace([
		{ content: "A", status: "pending" },
		{ content: "B", status: "pending", blockedBy: ["1"] },
	]);
	expect(list.updateStatus("1", "completed")?.status).toBe("completed");
	expect(openBlockers(list.get("2")!, list.list())).toEqual([]);
	list.updateStatus("2", "deleted");
	expect(list.list()).toHaveLength(1);
});

test("restores persisted snapshots and drops junk", () => {
	expect(parseTaskStore(null)).toEqual({ nextId: 1, tasks: [] });
	expect(parseTaskStore({ tasks: [{ id: "x" }] })).toEqual({ nextId: 1, tasks: [] });
	const parsed = parseTaskStore({
		nextId: 8,
		tasks: [{ id: "7", subject: "Keep me", status: "pending", blockedBy: ["7", "missing"], createdAt: 1, updatedAt: 2 }],
	});
	expect(parsed.nextId).toBe(8);
	expect(parsed.tasks[0]?.id).toBe("7");
	expect(parsed.tasks[0]?.blockedBy).toEqual(["7"]);
	const list = new TaskList();
	list.restore(parsed);
	expect(list.add("Next").id).toBe("8");
});

test("formats a compact list for the model and UI", () => {
	const list = new TaskList();
	list.replace([
		{ content: "Design API", status: "completed" },
		{ content: "Write handler", status: "in_progress", activeForm: "Writing handler" },
		{ content: "Add tests", status: "pending", blockedBy: ["2"] },
	]);
	const tasks = list.list();
	expect(summarizeTasks(tasks)).toBe("3 tasks · 1 in progress, 1 pending, 1 blocked, 1 done");
	expect(formatTaskList(tasks)).toBe([
		"#1 [completed] Design API",
		"#2 [in_progress] Write handler",
		"#3 [pending] Add tests [blocked by #2]",
	].join("\n"));
	expect(isBlocked(tasks[2]!, tasks)).toBe(true);
	expect(taskCounts(tasks).blocked).toBe(1);
});
