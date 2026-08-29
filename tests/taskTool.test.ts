import { expect, test } from "vitest";
import { createTaskTools } from "../src/tasks/createTaskTools.ts";
import { TaskList } from "../src/tasks/taskList.ts";
import { TASK_TOOL_NAME } from "../src/tasks/types.ts";

test("todo_write replaces the list and returns a compact confirmation", async () => {
	const list = new TaskList();
	const tool = createTaskTools(list).find((item) => item.name === TASK_TOOL_NAME)!;
	const created = await tool.execute("t1", {
		todos: [
			{ content: "Read the schema", status: "completed" },
			{ content: "Implement the tool", status: "in_progress", activeForm: "Implementing the tool" },
			{ content: "Add tests", status: "pending", blockedBy: ["2"] },
		],
	});
	expect(created.content[0]).toEqual({
		type: "text",
		text: [
			"3 tasks · 1 in progress, 1 pending, 1 blocked, 1 done",
			"#1 [completed] Read the schema",
			"#2 [in_progress] Implement the tool",
			"#3 [pending] Add tests [blocked by #2]",
		].join("\n"),
	});
	const cleared = await tool.execute("t2", { todos: [] });
	expect(cleared.content[0]).toEqual({ type: "text", text: "Cleared the task list." });
	expect(list.list()).toEqual([]);
});
