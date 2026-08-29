import {
	isResolvedStatus,
	isTaskStatus,
	MAX_ACTIVE_FORM_CHARS,
	MAX_SUBJECT_CHARS,
	MAX_TASKS,
	type Task,
	type TaskCounts,
	type TaskDraft,
	type TaskReplaceResult,
	type TaskStatus,
	type TaskStoreData,
} from "./types";

const ID_PATTERN = /^[0-9]{1,8}$/;

export class TaskList {
	#nextId = 1;
	#tasks = new Map<string, Task>();
	#listeners = new Set<() => void>();

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	list(): Task[] {
		return [...this.#tasks.values()].sort(compareTaskId);
	}

	get(id: string): Task | undefined {
		return this.#tasks.get(normalizeId(id) ?? id);
	}

	snapshot(): TaskStoreData {
		return { nextId: this.#nextId, tasks: this.list() };
	}

	restore(data: TaskStoreData): void {
		this.#tasks.clear();
		let maxId = 0;
		for (const task of data.tasks) {
			this.#tasks.set(task.id, { ...task, blockedBy: [...task.blockedBy] });
			const numeric = Number(task.id);
			if (Number.isInteger(numeric) && numeric > maxId) maxId = numeric;
		}
		this.#nextId = Math.max(data.nextId, maxId + 1, 1);
	}

	replace(drafts: TaskDraft[]): TaskReplaceResult {
		const warnings: string[] = [];
		const incoming = drafts.slice(0, MAX_TASKS);
		if (drafts.length > MAX_TASKS) warnings.push(`Kept ${MAX_TASKS} tasks, dropped ${drafts.length - MAX_TASKS}.`);

		const previousList = this.list();
		const incomingHasOpen = incoming.some((draft) => {
			const status = typeof draft.status === "string" && isTaskStatus(draft.status) ? draft.status : "pending";
			return status === "pending" || status === "in_progress";
		});
		const rollFinishedList = previousList.length > 0 && previousList.every((task) => isResolvedStatus(task.status)) && incomingHasOpen;
		const existing = rollFinishedList ? [] : previousList;
		const existingById = new Map(existing.map((task) => [task.id, task]));
		const now = Date.now();
		const assigned = assignIds(incoming, existing, this.#nextId);
		this.#nextId = assigned.nextId;

		const next = new Map<string, Task>();
		for (let index = 0; index < incoming.length; index += 1) {
			const draft = incoming[index]!;
			const id = assigned.ids[index]!;
			const parsed = parseDraft(draft, warnings, id);
			if (!parsed) continue;
			const previous = existingById.get(id);
			const status = parsed.status;
			const startedAt = status === "in_progress"
				? previous?.status === "in_progress" ? previous.startedAt ?? now : now
				: undefined;
			next.set(id, {
				id,
				subject: parsed.subject,
				activeForm: parsed.activeForm,
				status,
				blockedBy: [],
				createdAt: previous?.createdAt ?? now,
				updatedAt: previous && sameTask(previous, parsed.subject, parsed.activeForm, status) ? previous.updatedAt : now,
				startedAt,
			});
		}

		if (next.size === 0 && incoming.length > 0) {
			warnings.push("No valid tasks; each item needs non-empty content.");
		}

		applyBlockedBy(incoming, assigned.ids, next, warnings);
		demoteBlockedInProgress(next, warnings);
		demoteExtraInProgress(next, warnings);

		const nextIds = new Set(next.keys());
		const created = [...next.keys()].filter((id) => !existingById.has(id)).length;
		const removed = existing.filter((task) => !nextIds.has(task.id)).length;
		const updated = [...next.values()].filter((task) => {
			const previous = existingById.get(task.id);
			return previous !== undefined && !sameRecord(previous, task);
		}).length;

		this.#tasks = next;
		this.#bumpNextId();
		this.#emit();
		return { tasks: this.list(), warnings, created, updated, removed };
	}

	updateStatus(id: string, status: TaskStatus | "deleted"): Task | undefined {
		const key = normalizeId(id) ?? id;
		const task = this.#tasks.get(key);
		if (!task) return undefined;
		if (status === "deleted") {
			this.#tasks.delete(key);
			this.#stripBlocker(key);
			this.#emit();
			return undefined;
		}
		if (task.status === status) return { ...task, blockedBy: [...task.blockedBy] };
		const now = Date.now();
		const next: Task = {
			...task,
			status,
			blockedBy: [...task.blockedBy],
			updatedAt: now,
			startedAt: status === "in_progress" ? now : undefined,
		};
		this.#tasks.set(key, next);
		if (status === "in_progress") {
			demoteExtraInProgress(this.#tasks, []);
			demoteBlockedInProgress(this.#tasks, []);
		}
		this.#emit();
		return this.get(key);
	}

	add(subject: string, activeForm?: string): Task {
		const now = Date.now();
		const task: Task = {
			id: String(this.#nextId++),
			subject: clampText(subject, MAX_SUBJECT_CHARS),
			activeForm: activeForm ? clampText(activeForm, MAX_ACTIVE_FORM_CHARS) : undefined,
			status: "pending",
			blockedBy: [],
			createdAt: now,
			updatedAt: now,
		};
		this.#tasks.set(task.id, task);
		this.#emit();
		return { ...task, blockedBy: [] };
	}

	clearCompleted(): number {
		let count = 0;
		for (const [id, task] of [...this.#tasks]) {
			if (!isResolvedStatus(task.status)) continue;
			this.#tasks.delete(id);
			count += 1;
		}
		if (count > 0) {
			this.#pruneBlockers();
			this.#emit();
		}
		return count;
	}

	clearAll(): number {
		const count = this.#tasks.size;
		if (count === 0) return 0;
		this.#tasks.clear();
		this.#emit();
		return count;
	}

	#stripBlocker(id: string): void {
		for (const task of this.#tasks.values()) {
			if (!task.blockedBy.includes(id)) continue;
			task.blockedBy = task.blockedBy.filter((blocker) => blocker !== id);
			task.updatedAt = Date.now();
		}
	}

	#pruneBlockers(): void {
		const valid = new Set(this.#tasks.keys());
		for (const task of this.#tasks.values()) {
			task.blockedBy = task.blockedBy.filter((id) => valid.has(id));
		}
	}

	#bumpNextId(): void {
		let maxId = 0;
		for (const id of this.#tasks.keys()) {
			const numeric = Number(id);
			if (Number.isInteger(numeric) && numeric > maxId) maxId = numeric;
		}
		if (this.#nextId <= maxId) this.#nextId = maxId + 1;
	}

	#emit(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

export function parseTaskStore(value: unknown): TaskStoreData {
	if (!value || typeof value !== "object") return { nextId: 1, tasks: [] };
	const record = value as Partial<TaskStoreData>;
	if (!Array.isArray(record.tasks)) return { nextId: 1, tasks: [] };
	const tasks: Task[] = [];
	let maxId = 0;
	for (const item of record.tasks) {
		const task = parseStoredTask(item);
		if (!task) continue;
		tasks.push(task);
		const numeric = Number(task.id);
		if (Number.isInteger(numeric) && numeric > maxId) maxId = numeric;
	}
	const nextId = typeof record.nextId === "number" && Number.isInteger(record.nextId) && record.nextId > maxId
		? record.nextId
		: maxId + 1;
	return { nextId: Math.max(1, nextId), tasks };
}

export function taskCounts(tasks: Task[]): TaskCounts {
	const counts: TaskCounts = { total: tasks.length, pending: 0, inProgress: 0, completed: 0, skipped: 0, blocked: 0, resolved: 0 };
	for (const task of tasks) {
		if (task.status === "pending") counts.pending += 1;
		else if (task.status === "in_progress") counts.inProgress += 1;
		else if (task.status === "completed") counts.completed += 1;
		else counts.skipped += 1;
		if (isResolvedStatus(task.status)) counts.resolved += 1;
		if (openBlockers(task, tasks).length > 0) counts.blocked += 1;
	}
	return counts;
}

export function openBlockers(task: Task, tasks: readonly Task[]): string[] {
	if (task.blockedBy.length === 0) return [];
	const byId = new Map(tasks.map((item) => [item.id, item]));
	return task.blockedBy.filter((id) => {
		const blocker = byId.get(id);
		return blocker !== undefined && !isResolvedStatus(blocker.status);
	});
}

export function isBlocked(task: Task, tasks: readonly Task[]): boolean {
	return task.status === "pending" && openBlockers(task, tasks).length > 0;
}

export function activeTask(tasks: readonly Task[]): Task | undefined {
	return tasks.find((task) => task.status === "in_progress");
}

export function formatTaskList(tasks: Task[]): string {
	if (tasks.length === 0) return "No tasks.";
	return tasks.map((task) => formatTaskLine(task, tasks)).join("\n");
}

export function formatTaskLine(task: Task, tasks: readonly Task[]): string {
	const blockers = openBlockers(task, tasks);
	const blocked = blockers.length > 0 ? ` [blocked by ${blockers.map((id) => `#${id}`).join(", ")}]` : "";
	return `#${task.id} [${task.status}] ${task.subject}${blocked}`;
}

export function summarizeTasks(tasks: Task[]): string {
	const counts = taskCounts(tasks);
	if (counts.total === 0) return "No tasks";
	const parts: string[] = [];
	if (counts.inProgress) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending) parts.push(`${counts.pending} pending`);
	if (counts.blocked) parts.push(`${counts.blocked} blocked`);
	if (counts.completed) parts.push(`${counts.completed} done`);
	if (counts.skipped) parts.push(`${counts.skipped} skipped`);
	return `${counts.total} task${counts.total === 1 ? "" : "s"} · ${parts.join(", ")}`;
}

function parseStoredTask(value: unknown): Task | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<Task>;
	const id = normalizeId(typeof record.id === "string" ? record.id : undefined);
	const subject = typeof record.subject === "string" ? clampText(record.subject, MAX_SUBJECT_CHARS) : "";
	if (!id || !subject) return undefined;
	const status = typeof record.status === "string" && isTaskStatus(record.status) ? record.status : "pending";
	const activeForm = typeof record.activeForm === "string" ? clampText(record.activeForm, MAX_ACTIVE_FORM_CHARS) : undefined;
	const blockedBy = Array.isArray(record.blockedBy)
		? uniqueIds(record.blockedBy.map((item) => typeof item === "string" ? normalizeId(item) : undefined).filter((item): item is string => Boolean(item)))
		: [];
	const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
	const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt;
	const startedAt = typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : undefined;
	return {
		id,
		subject,
		activeForm: activeForm || undefined,
		status,
		blockedBy,
		createdAt,
		updatedAt,
		startedAt: status === "in_progress" ? startedAt : undefined,
	};
}

function parseDraft(draft: TaskDraft, warnings: string[], id: string): { subject: string; activeForm?: string; status: TaskStatus } | undefined {
	const subject = typeof draft.content === "string" ? clampText(draft.content.replace(/[\r\n]+/g, " ").replace(/<\/?system-reminder>/gi, ""), MAX_SUBJECT_CHARS) : "";
	if (!subject) {
		warnings.push(`#${id} skipped: empty content.`);
		return undefined;
	}
	const statusRaw = typeof draft.status === "string" ? draft.status.trim() : "pending";
	const status = isTaskStatus(statusRaw) ? statusRaw : "pending";
	if (statusRaw && !isTaskStatus(statusRaw)) warnings.push(`#${id} invalid status "${statusRaw}"; using pending.`);
	const activeForm = typeof draft.activeForm === "string"
		? clampText(draft.activeForm.replace(/[\r\n]+/g, " "), MAX_ACTIVE_FORM_CHARS) || undefined
		: undefined;
	return { subject, activeForm, status };
}

function assignIds(drafts: TaskDraft[], existing: Task[], nextId: number): { ids: string[]; nextId: number } {
	const used = new Set<string>();
	const ids: string[] = [];
	let cursor = nextId;
	const nameless = drafts.every((draft) => !normalizeId(typeof draft.id === "string" ? draft.id : undefined));
	if (nameless) {
		for (let index = 0; index < drafts.length; index += 1) {
			const reused = existing[index]?.id;
			if (reused && !used.has(reused)) {
				used.add(reused);
				ids.push(reused);
				continue;
			}
			const id = takeNextId(cursor, used);
			cursor = Number(id) + 1;
			used.add(id);
			ids.push(id);
		}
		return { ids, nextId: cursor };
	}
	for (const draft of drafts) {
		const requested = normalizeId(typeof draft.id === "string" ? draft.id : undefined);
		if (requested && !used.has(requested)) {
			used.add(requested);
			ids.push(requested);
			cursor = Math.max(cursor, Number(requested) + 1);
			continue;
		}
		const id = takeNextId(cursor, used);
		cursor = Number(id) + 1;
		used.add(id);
		ids.push(id);
	}
	return { ids, nextId: cursor };
}

function takeNextId(start: number, used: Set<string>): string {
	let cursor = Math.max(1, start);
	while (used.has(String(cursor))) cursor += 1;
	return String(cursor);
}

function applyBlockedBy(drafts: TaskDraft[], ids: string[], tasks: Map<string, Task>, warnings: string[]): void {
	for (let index = 0; index < drafts.length; index += 1) {
		const id = ids[index]!;
		const task = tasks.get(id);
		if (!task) continue;
		const raw = drafts[index]?.blockedBy;
		if (!Array.isArray(raw) || raw.length === 0) continue;
		const blockers: string[] = [];
		for (const item of raw) {
			const blockerId = normalizeId(typeof item === "string" || typeof item === "number" ? String(item) : undefined);
			if (!blockerId) continue;
			if (blockerId === id) {
				warnings.push(`#${id} cannot block itself.`);
				continue;
			}
			if (!tasks.has(blockerId)) {
				warnings.push(`#${id} blocked by missing #${blockerId}.`);
				continue;
			}
			if (blockers.includes(blockerId)) continue;
			blockers.push(blockerId);
		}
		task.blockedBy = blockers;
	}
	for (const task of tasks.values()) {
		for (const blockerId of task.blockedBy) {
			const blocker = tasks.get(blockerId);
			if (blocker?.blockedBy.includes(task.id)) warnings.push(`cycle: #${task.id} and #${blockerId} block each other.`);
		}
	}
}

function demoteBlockedInProgress(tasks: Map<string, Task>, warnings: string[]): void {
	const list = [...tasks.values()];
	for (const task of list) {
		if (task.status !== "in_progress") continue;
		const blockers = openBlockers(task, list);
		if (blockers.length === 0) continue;
		task.status = "pending";
		task.startedAt = undefined;
		task.updatedAt = Date.now();
		warnings.push(`#${task.id} still pending; blocked by ${blockers.map((id) => `#${id}`).join(", ")}.`);
	}
}

function demoteExtraInProgress(tasks: Map<string, Task>, warnings: string[]): void {
	const active = [...tasks.values()].filter((task) => task.status === "in_progress").sort(compareTaskId);
	if (active.length <= 1) return;
	for (const task of active.slice(1)) {
		task.status = "pending";
		task.startedAt = undefined;
		task.updatedAt = Date.now();
		warnings.push(`Only one in_progress task; demoted #${task.id}.`);
	}
}

function sameTask(previous: Task, subject: string, activeForm: string | undefined, status: TaskStatus): boolean {
	return previous.subject === subject && previous.activeForm === activeForm && previous.status === status;
}

function sameRecord(left: Task, right: Task): boolean {
	return left.subject === right.subject
		&& left.activeForm === right.activeForm
		&& left.status === right.status
		&& left.startedAt === right.startedAt
		&& sameIds(left.blockedBy, right.blockedBy);
}

function sameIds(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((id, index) => id === right[index]);
}

function uniqueIds(ids: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

export function normalizeId(value: string | undefined): string | undefined {
	const trimmed = value?.trim().replace(/^#/, "");
	if (!trimmed || !ID_PATTERN.test(trimmed)) return undefined;
	return String(Number(trimmed));
}

function clampText(value: string, max: number): string {
	const text = value.trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function compareTaskId(left: Task, right: Task): number {
	return Number(left.id) - Number(right.id);
}
