export const TASK_STATUSES = ["pending", "in_progress", "completed", "skipped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TOOL_NAME = "todo_write";
export const MAX_TASKS = 20;
export const MAX_SUBJECT_CHARS = 120;
export const MAX_ACTIVE_FORM_CHARS = 80;

export type Task = {
	id: string;
	subject: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
};

export type TaskDraft = {
	id?: string;
	content?: unknown;
	activeForm?: unknown;
	status?: unknown;
	blockedBy?: unknown;
};

export type TaskStoreData = {
	nextId: number;
	tasks: Task[];
};

export type TaskCounts = {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	skipped: number;
	blocked: number;
	resolved: number;
};

export type TaskReplaceResult = {
	tasks: Task[];
	warnings: string[];
	created: number;
	updated: number;
	removed: number;
};

export function isTaskStatus(value: string): value is TaskStatus {
	return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isResolvedStatus(status: TaskStatus): boolean {
	return status === "completed" || status === "skipped";
}
