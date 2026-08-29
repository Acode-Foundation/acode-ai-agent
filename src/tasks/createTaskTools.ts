import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatTaskList, summarizeTasks, TaskList } from "./taskList";
import { MAX_TASKS, TASK_TOOL_NAME, type TaskDraft } from "./types";

const DESCRIPTION = [
	"Keep a compact session checklist for multi-step work. Replace the full list on every call. Titles are short and imperative.",
	"Use for 3+ steps, explicit todo requests, or when starting/finishing a step. Skip one-step or conversational work.",
	"Only one task may be in_progress; mark it before you start. Complete only when fully done, otherwise skip.",
	"blockedBy is ids that must complete or skip first. Do not paste the list into chat; the user already sees it.",
].join("\n");

export function createTaskTools(list: TaskList): AgentTool<any>[] {
	const todoWrite: AgentTool<any> = {
		name: TASK_TOOL_NAME,
		label: "Update tasks",
		description: DESCRIPTION,
		parameters: Type.Object({
			todos: Type.Array(Type.Object({
				id: Type.Optional(Type.String({ description: "Existing task id from a previous todo_write result. Omit to create." })),
				content: Type.String({ description: "Short imperative title" }),
				activeForm: Type.Optional(Type.String({ description: "Present continuous status shown while in_progress, e.g. Running tests" })),
				status: Type.Optional(Type.String({ description: "pending, in_progress, completed, or skipped. Defaults to pending." })),
				blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must finish first" })),
			}), { maxItems: MAX_TASKS, description: "The complete task list after this update" }),
		}),
		executionMode: "sequential",
		execute: async (_id, params) => {
			const raw = (params as { todos?: unknown }).todos;
			const todos = Array.isArray(raw) ? raw.filter(isTaskDraft) : [];
			const result = list.replace(todos);
			return formatWriteResult(result.tasks, result.warnings, todos.length === 0);
		},
	};
	return [todoWrite];
}

export function formatWriteResult(tasks: ReturnType<TaskList["list"]>, warnings: string[], cleared: boolean): AgentToolResult<{ operation: string; count: number }> {
	if (cleared || tasks.length === 0) {
		const warning = warnings.length ? `\n${warnings.map((item) => `warning: ${item}`).join("\n")}` : "";
		return textResult(`Cleared the task list.${warning}`, 0);
	}
	const lines = [summarizeTasks(tasks), formatTaskList(tasks)];
	if (warnings.length) lines.push(warnings.map((item) => `warning: ${item}`).join("\n"));
	return textResult(lines.join("\n"), tasks.length);
}

function textResult(content: string, count = 0): AgentToolResult<{ operation: string; count: number }> {
	return { content: [{ type: "text", text: content }], details: { operation: "todos", count } };
}

function isTaskDraft(item: unknown): item is TaskDraft {
	return Boolean(item && typeof item === "object");
}
