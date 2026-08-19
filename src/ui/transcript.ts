import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolActivity } from "../core/types";
import { userPartsFromMessage, type UserPart } from "./composerDraft";

export type WorkStatus = "running" | "done" | "error";
export type ToolKind = "read" | "change" | "search" | "list" | "think" | "other";

export type WorkEntry = {
	id: string;
	type: "tool" | "thinking" | "note";
	kind: ToolKind;
	name: string;
	label: string;
	detail?: string;
	status: WorkStatus;
	output?: string;
	args?: Record<string, unknown>;
};

export type ChatTurn = {
	id: string;
	user?: string;
	userParts?: UserPart[];
	work: WorkEntry[];
	answer?: string;
	notice?: { kind: "compaction" | "branch"; text: string };
	streaming?: boolean;
	startedAt?: number;
	endedAt?: number;
};

export function buildTurns(
	messages: AgentMessage[],
	streamingMessage?: AgentMessage,
	activities: ToolActivity[] = [],
	isRunning = false,
): ChatTurn[] {
	const transcript = [...messages];
	if (streamingMessage && !transcript.includes(streamingMessage)) {
		const last = transcript[transcript.length - 1];
		if (last && last.role === streamingMessage.role && "timestamp" in last && last.timestamp === streamingMessage.timestamp) {
			transcript[transcript.length - 1] = streamingMessage;
		} else {
			transcript.push(streamingMessage);
		}
	}

	const turns: ChatTurn[] = [];
	let bucket: AgentMessage[] = [];

	const flushBucket = () => {
		if (!bucket.length) return;
		turns.push(projectTurn(bucket, isRunning && streamingMessage !== undefined && bucket.includes(streamingMessage)));
		bucket = [];
	};

	for (const message of transcript) {
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			flushBucket();
			turns.push(noticeTurn(message));
			continue;
		}
		if (message.role === "user") {
			flushBucket();
			bucket = [message];
			continue;
		}
		if (!bucket.length) bucket = [];
		bucket.push(message);
	}
	flushBucket();

	const last = turns[turns.length - 1];
	if (last && isRunning && isLiveCurrentTurn(last, transcript)) {
		last.streaming = true;
		const priorWorkIds = new Set(turns.slice(0, -1).flatMap((turn) => turn.work.map((entry) => entry.id)));
		mergeActivities(last, activities, priorWorkIds);
	}
	for (const turn of turns) settleStoppedWork(turn);

	return turns;
}

function settleStoppedWork(turn: ChatTurn): void {
	if (turn.streaming) return;
	for (const entry of turn.work) {
		if (entry.status === "running") entry.status = "done";
	}
}

function isLiveCurrentTurn(turn: ChatTurn, transcript: AgentMessage[]): boolean {
	if (turn.streaming) return true;
	const lastMessage = transcript[transcript.length - 1];
	if (!lastMessage) return false;
	if (lastMessage.role === "user" || lastMessage.role === "toolResult") return true;
	if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content) && lastMessage.content.some((part) => part.type === "toolCall")) return true;
	return turn.work.some((entry) => entry.status === "running");
}

export function formatWorkDuration(durationMs: number): string {
	const totalSeconds = Math.round(durationMs / 1_000);
	if (totalSeconds < 1) return "under a second";
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 && hours === 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

export function turnDurationMs(turn: ChatTurn, now = Date.now()): number | undefined {
	if (typeof turn.startedAt !== "number") return undefined;
	const end = turn.streaming ? now : turn.endedAt ?? now;
	const duration = end - turn.startedAt;
	return duration > 0 && duration <= 24 * 60 * 60 * 1_000 ? duration : undefined;
}

export function presentTool(name: string, args: Record<string, unknown> = {}, output?: string): { kind: ToolKind; label: string; detail?: string } {
	const path = firstString(args, ["path", "file_path", "filePath", "filename", "target"]);
	const query = firstString(args, ["query", "pattern", "search", "needle"]);
	switch (name) {
		case "read_file":
			return { kind: "read", label: "Read file", detail: readDetail(path, args, output) };
		case "list_dir":
			return { kind: "list", label: "Listed folder", detail: path && path !== "." ? path : undefined };
		case "grep":
			return { kind: "search", label: "Searched files", detail: query };
		case "glob":
			return { kind: "search", label: "Found files", detail: query ?? path };
		case "write_file":
			return { kind: "change", label: "Wrote file", detail: path };
		case "edit_file":
			return { kind: "change", label: "Changed files", detail: path };
		case "thinking":
			return { kind: "think", label: "Reasoned", detail: undefined };
		default:
			return { kind: "other", label: humanize(name) || "Used tool", detail: path ?? query };
	}
}

export type WorkGroup = { kind: "actions"; entries: WorkEntry[] } | { kind: "content"; entry: WorkEntry };

export type DirEntry = { kind: "dir" | "file"; name: string };

export function parseDirListing(output?: string): DirEntry[] | undefined {
	if (!output) return undefined;
	if (output === "Directory is empty.") return [];
	const entries = output.split("\n").flatMap((line) => {
		const match = /^([df])\s+(\S.*)$/.exec(line.trim());
		if (!match) return [];
		const raw = match[2]!.trim();
		const name = raw.split("/").filter(Boolean).pop() ?? raw;
		return [{ kind: match[1] === "d" ? "dir" as const : "file" as const, name }];
	});
	return entries.length ? entries : undefined;
}

export function splitWorkBurst(entries: WorkEntry[], live: boolean): { featured: WorkEntry[]; grouped: WorkEntry[] } {
	if (!entries.length) return { featured: [], grouped: [] };
	const running = live ? entries.filter((entry) => entry.status === "running") : [];
	if (running.length) {
		const featuredIds = new Set(running.map((entry) => entry.id));
		return {
			featured: running,
			grouped: entries.filter((entry) => !featuredIds.has(entry.id)),
		};
	}
	return {
		featured: [entries[entries.length - 1]!],
		grouped: entries.slice(0, -1),
	};
}

export function groupWorkEntries(entries: WorkEntry[]): WorkGroup[] {
	const groups: WorkGroup[] = [];
	let burst: WorkEntry[] = [];
	const flush = () => {
		if (!burst.length) return;
		groups.push({ kind: "actions", entries: burst });
		burst = [];
	};
	for (const entry of entries) {
		if (entry.type === "tool") {
			burst.push(entry);
			continue;
		}
		flush();
		groups.push({ kind: "content", entry });
	}
	flush();
	return groups;
}

function noticeTurn(message: AgentMessage): ChatTurn {
	const kind = message.role === "branchSummary" ? "branch" : "compaction";
	const text = "summary" in message && typeof message.summary === "string" ? message.summary : "";
	const timestamp = "timestamp" in message ? message.timestamp : Date.now();
	return {
		id: `${kind}-${timestamp}`,
		work: [],
		notice: { kind, text },
		startedAt: timestamp,
		endedAt: timestamp,
	};
}

function projectTurn(messages: AgentMessage[], streaming: boolean): ChatTurn {
	const user = messages.find((message) => message.role === "user");
	const parts = flatten(messages);
	let lastWork = -1;
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		if (parts[index]!.kind !== "text") {
			lastWork = index;
			break;
		}
	}

	const work: WorkEntry[] = [];
	const answer: string[] = [];
	const tools = new Map<string, WorkEntry>();

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		const inWork = lastWork >= 0 && index <= lastWork;
		if (part.kind === "thinking") {
			work.push({
				id: `thinking-${index}`,
				type: "thinking",
				kind: "think",
				name: "thinking",
				label: "Reasoned",
				status: "done",
				output: part.text,
			});
			continue;
		}
		if (part.kind === "tool") {
			const presented = presentTool(part.name, part.args);
			const entry: WorkEntry = {
				id: part.id,
				type: "tool",
				kind: presented.kind,
				name: part.name,
				label: presented.label,
				detail: presented.detail,
				status: "running",
				args: part.args,
			};
			tools.set(part.id, entry);
			work.push(entry);
			continue;
		}
		if (part.kind === "result") {
			const existing = tools.get(part.id);
			if (existing) {
				existing.status = part.error ? "error" : "done";
				existing.output = part.text;
				existing.detail = presentTool(part.name, existing.args ?? {}, part.text).detail ?? existing.detail;
			} else {
				const presented = presentTool(part.name, {}, part.text);
				work.push({
					id: part.id,
					type: "tool",
					kind: presented.kind,
					name: part.name,
					label: presented.label,
					detail: presented.detail,
					status: part.error ? "error" : "done",
					output: part.text,
				});
			}
			continue;
		}
		if (inWork) {
			work.push({
				id: `note-${index}`,
				type: "note",
				kind: "other",
				name: "note",
				label: "Note",
				status: "done",
				output: part.text,
			});
		} else if (part.text.trim()) {
			answer.push(part.text);
		}
	}

	const lastMessage = messages[messages.length - 1];
	return {
		id: user ? `user-${user.timestamp}` : `turn-${messages[0]?.timestamp ?? 0}`,
		user: user ? userText(user) : undefined,
		userParts: user ? userPartsFromMessage(user.content) : undefined,
		work,
		answer: answer.join("\n\n").trim() || undefined,
		streaming,
		startedAt: user?.timestamp ?? messages[0]?.timestamp,
		endedAt: lastMessage && "timestamp" in lastMessage ? lastMessage.timestamp : undefined,
	};
}

type FlatPart =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; id: string; name: string; args: Record<string, unknown> }
	| { kind: "result"; id: string; name: string; text: string; error: boolean };

function flatten(messages: AgentMessage[]): FlatPart[] {
	const parts: FlatPart[] = [];
	for (const message of messages) {
		if (message.role === "user") continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "thinking" && part.thinking.trim()) parts.push({ kind: "thinking", text: part.thinking });
				else if (part.type === "toolCall") parts.push({ kind: "tool", id: part.id, name: part.name, args: part.arguments ?? {} });
				else if (part.type === "text" && part.text.trim()) parts.push({ kind: "text", text: part.text });
			}
			continue;
		}
		if (message.role === "toolResult") {
			parts.push({
				kind: "result",
				id: message.toolCallId,
				name: message.toolName,
				text: toolMessageText(message),
				error: message.isError,
			});
		}
	}
	return parts;
}

function mergeActivities(turn: ChatTurn, activities: ToolActivity[], priorWorkIds: Set<string>): void {
	for (const activity of activities) {
		const presented = presentTool(activity.name, activity.args);
		const existing = turn.work.find((entry) => entry.id === activity.id);
		if (existing) {
			if (activity.status === "running") existing.status = "running";
			if (activity.status === "error") existing.status = "error";
			if (activity.summary && (!existing.output || existing.status === "running")) existing.output = activity.summary;
			existing.detail = presentTool(activity.name, activity.args, existing.output).detail ?? presented.detail;
			continue;
		}
		if (priorWorkIds.has(activity.id)) continue;
		turn.work.push({
			id: activity.id,
			type: "tool",
			kind: presented.kind,
			name: activity.name,
			label: presented.label,
			detail: presented.detail,
			status: activity.status,
			output: activity.summary,
			args: activity.args,
		});
	}
}

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function toolMessageText(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function splitReadOutput(output?: string): { body: string; notice?: string } {
	if (!output) return { body: "" };
	const leading = /^\[((?:Showing lines |\d+ more lines in file|Line \d+ exceeds)[^\]]*)\]\n\n/.exec(output);
	if (leading) return { body: output.slice(leading[0].length), notice: leading[1] };
	const trailing = /\n\n\[((?:Showing lines |\d+ more lines in file|Line \d+ exceeds)[^\]]*)\]\s*$/.exec(output);
	if (trailing) return { body: output.slice(0, trailing.index), notice: trailing[1] };
	return { body: output };
}

function readDetail(path: string | undefined, args: Record<string, unknown>, output?: string): string | undefined {
	if (!path) return undefined;
	const showing = /Showing lines (\d+)-(\d+) of (\d+)/.exec(output ?? "");
	if (showing) return `${path}:${showing[1]}-${showing[2]} of ${showing[3]}`;
	const offset = asPositiveInt(args.offset);
	const limit = asPositiveInt(args.limit);
	if (offset === undefined && limit === undefined) return path;
	const start = offset ?? 1;
	return limit === undefined ? `${path}:${start}` : `${path}:${start}-${start + limit - 1}`;
}

function asPositiveInt(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(number) || number < 1) return undefined;
	return Math.floor(number);
}

function humanize(value: string): string {
	const leaf = value.split(/[.:/]/).pop() ?? value;
	const words = leaf.replace(/[_-]+/g, " ").trim();
	return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "";
}
