import { expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildTurns, formatWorkDuration, groupWorkEntries, parseDirListing, parseToolFileResults, presentTool, splitReadOutput, splitWorkBurst, type WorkEntry } from "../src/ui/transcript.ts";

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(content: AgentMessage extends { role: "assistant"; content: infer C } ? C : never, timestamp = 2): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

test("projects a tool turn into a work log plus the trailing answer", () => {
	const turns = buildTurns([
		user("fix the header"),
		assistant([
			{ type: "thinking", thinking: "I should read the file first." },
			{ type: "text", text: "Looking at App.tsx" },
			{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "src/ui/App.tsx" } },
		], 2),
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read_file",
			content: [{ type: "text", text: "export function App() {}" }],
			isError: false,
			timestamp: 3,
		},
		assistant([{ type: "text", text: "The header is unused. I'll remove it." }], 4),
	]);

	expect(turns).toHaveLength(1);
	expect(turns[0]?.user).toBe("fix the header");
	expect(turns[0]?.userParts).toEqual([{ type: "text", text: "fix the header" }]);
	expect(turns[0]?.work[0]?.type).toBe("thinking");
	expect(turns[0]?.work[1]?.type).toBe("note");
	expect(turns[0]?.work[2]?.label).toBe("Read file");
	expect(turns[0]?.work[2]?.detail).toBe("src/ui/App.tsx");
	expect(turns[0]?.work[2]?.status).toBe("done");
	expect(turns[0]?.work[2]?.output).toBe("export function App() {}");
	expect(turns[0]?.answer).toBe("The header is unused. I'll remove it.");
});

test("shows the read window on the work row after the tool result arrives", () => {
	const turns = buildTurns([
		user("read it"),
		assistant([{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "src/a.ts" } }], 2),
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read_file",
			content: [{ type: "text", text: "[Showing lines 1-2000 of 8432. Use offset=2001 to continue.]\n\nconst x = 1;" }],
			isError: false,
			timestamp: 3,
		},
	]);
	expect(turns[0]?.work[0]?.detail).toBe("src/a.ts:1-2000 of 8432");
});

test("renders a compaction summary as a notice, not as a chat bubble", () => {
	const turns = buildTurns([
		{
			role: "compactionSummary",
			summary: "Earlier turns covered the header rewrite.",
			tokensBefore: 80_000,
			timestamp: 9,
		} as AgentMessage,
		user("continue"),
		assistant([{ type: "text", text: "Next I will edit App.tsx." }]),
	]);
	expect(turns[0]?.notice?.kind).toBe("compaction");
	expect(turns[0]?.notice?.text).toBe("Earlier turns covered the header rewrite.");
	expect(turns[1]?.user).toBe("continue");
});

test("surfaces a failed model request instead of an empty turn", () => {
	const failed = assistant([], 2);
	failed.stopReason = "error";
	failed.errorMessage = "Provider returned error: No available channel";
	const turns = buildTurns([user("hello"), failed]);
	expect(turns[0]?.answer).toBeUndefined();
	expect(turns[0]?.error).toBe("Provider returned error: No available channel");
});

test("surfaces an empty completion so the turn is not silent", () => {
	const turns = buildTurns([user("hello"), assistant([], 2)]);
	expect(turns[0]?.error).toMatch(/empty response/i);
});

test("keeps a text-only reply as the answer with no work log", () => {
	const turns = buildTurns([
		user("hi"),
		assistant([{ type: "text", text: "Hello. Open a file and I can help." }]),
	]);
	expect(turns[0]?.work).toHaveLength(0);
	expect(turns[0]?.answer).toBe("Hello. Open a file and I can help.");
});

test("labels common tools", () => {
	expect(presentTool("grep", { query: "TODO" })).toEqual({ kind: "search", label: "Searched files", detail: "TODO" });
	expect(presentTool("edit_file", { path: "a.ts" })).toEqual({ kind: "change", label: "Changed files", detail: "a.ts" });
	expect(presentTool("bash", { command: "npm test" })).toEqual({ kind: "terminal", label: "Ran command", detail: "npm test" });
	expect(presentTool("bash", { command: "npm test\n  npm run build" })).toEqual({
		kind: "terminal",
		label: "Ran command",
		detail: "npm test npm run build",
	});
	expect(presentTool("read_file", { path: "src/a.ts", offset: 10, limit: 31 })).toEqual({
		kind: "read",
		label: "Read file",
		detail: "src/a.ts:10-40",
	});
	expect(
		presentTool("read_file", { path: "src/a.ts" }, "[Showing lines 1-2000 of 8432. Use offset=2001 to continue.]\n\nalpha"),
	).toEqual({ kind: "read", label: "Read file", detail: "src/a.ts:1-2000 of 8432" });
});

test("splits the read truncation notice out of the file body", () => {
	expect(
		splitReadOutput("[Showing lines 1-2 of 9. Use offset=3 to continue.]\n\none\ntwo"),
	).toEqual({ body: "one\ntwo", notice: "Showing lines 1-2 of 9. Use offset=3 to continue." });
});

test("groups consecutive tools into one burst", () => {
	const groups = groupWorkEntries([
		{ id: "t1", type: "tool", kind: "read", name: "read_file", label: "Read file", status: "done" },
		{ id: "t2", type: "tool", kind: "search", name: "grep", label: "Searched files", status: "done" },
		{ id: "n1", type: "note", kind: "other", name: "note", label: "Note", status: "done", output: "ok" },
	]);
	expect(groups[0]?.kind).toBe("actions");
	expect(groups[0] && groups[0].kind === "actions" ? groups[0].entries.length : 0).toBe(2);
	expect(groups[1]?.kind).toBe("content");
});

function tool(id: string, status: WorkEntry["status"] = "done"): WorkEntry {
	return { id, type: "tool", kind: "read", name: "read_file", label: "Read file", status };
}

test("while live, groups finished tools and keeps the running tool featured", () => {
	const split = splitWorkBurst([tool("t1"), tool("t2"), tool("t3", "running")], true);
	expect(split.featured.map((entry) => entry.id)).toEqual(["t3"]);
	expect(split.grouped.map((entry) => entry.id)).toEqual(["t1", "t2"]);
});

test("while live, folds a finished latest tool into the group once a later tool is running", () => {
	const afterFirst = splitWorkBurst([tool("t1"), tool("t2")], true);
	expect(afterFirst.featured.map((entry) => entry.id)).toEqual(["t2"]);
	expect(afterFirst.grouped.map((entry) => entry.id)).toEqual(["t1"]);

	const nextRunning = splitWorkBurst([tool("t1"), tool("t2"), tool("t3", "running")], true);
	expect(nextRunning.featured.map((entry) => entry.id)).toEqual(["t3"]);
	expect(nextRunning.grouped.map((entry) => entry.id)).toEqual(["t1", "t2"]);
});

test("while live, shows every running tool and groups the rest", () => {
	const split = splitWorkBurst([tool("t1"), tool("t2", "running"), tool("t3", "error"), tool("t4", "running")], true);
	expect(split.featured.map((entry) => entry.id)).toEqual(["t2", "t4"]);
	expect(split.grouped.map((entry) => entry.id)).toEqual(["t1", "t3"]);
});

test("when nothing is running, keeps the last tool featured like the settled burst", () => {
	const liveIdle = splitWorkBurst([tool("t1"), tool("t2"), tool("t3")], true);
	const settled = splitWorkBurst([tool("t1"), tool("t2"), tool("t3")], false);
	expect(liveIdle).toEqual(settled);
	expect(settled.featured.map((entry) => entry.id)).toEqual(["t3"]);
	expect(settled.grouped.map((entry) => entry.id)).toEqual(["t1", "t2"]);
});

test("formats short work durations", () => {
	expect(formatWorkDuration(400)).toBe("under a second");
	expect(formatWorkDuration(5_700)).toBe("6s");
	expect(formatWorkDuration(12_000)).toBe("12s");
	expect(formatWorkDuration(75_000)).toBe("1m 15s");
	expect(formatWorkDuration(3_600_000)).toBe("1h");
	expect(formatWorkDuration(3_721_000)).toBe("1h 2m");
});

test("keeps the turn id stable as the assistant turn grows", () => {
	const first = buildTurns([
		user("fix it", 10),
		assistant([{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.ts" } }], 11),
	]);
	const second = buildTurns([
		user("fix it", 10),
		assistant([
			{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "t2", name: "edit_file", arguments: { path: "a.ts" } },
		], 12),
	], undefined, [], true);
	expect(first[0]?.id).toBe("user-10");
	expect(second[0]?.id).toBe(first[0]?.id);
	expect(second[0]?.work[0]?.id).toBe("t1");
	expect(second[0]?.work[1]?.id).toBe("t2");
	expect(second[0]?.streaming).toBe(true);
});

test("parses list_dir output into basenames without host class names", () => {
	const entries = parseDirListing("d  utils\nd  www\nf  package.json\nf  src/main.ts");
	expect(entries).toEqual([
		{ kind: "dir", name: "utils" },
		{ kind: "dir", name: "www" },
		{ kind: "file", name: "package.json" },
		{ kind: "file", name: "main.ts" },
	]);
	expect(parseDirListing("Directory is empty.")).toHaveLength(0);
});

test("parses grep and glob output into navigable file results", () => {
	expect(parseToolFileResults("grep", "src/ui/App.tsx:42: return <App />;\nsrc/main.ts:8: mountApp();")).toEqual([
		{ path: "src/ui/App.tsx", line: 42, preview: "return <App />;" },
		{ path: "src/main.ts", line: 8, preview: "mountApp();" },
	]);
	expect(parseToolFileResults("glob", "src/ui/App.tsx\nsrc/main.ts")).toEqual([
		{ path: "src/ui/App.tsx" },
		{ path: "src/main.ts" },
	]);
	expect(parseToolFileResults("glob", "No files matched **/*.vue in 12 files.")).toEqual([]);
	expect(parseToolFileResults("grep", "Searched src/ui/App.tsx")).toBeUndefined();
});

test("keeps the last turn live while the run is active even without a streaming message", () => {
	const turns = buildTurns(
		[user("look around", 4)],
		undefined,
		[{ id: "t1", name: "list_dir", args: { path: "." }, status: "running", startedAt: 5 }],
		true,
	);
	expect(turns[0]?.streaming).toBe(true);
	expect(turns[0]?.work[0]?.id).toBe("t1");
	expect(turns[0]?.work[0]?.label).toBe("Listed folder");
});

test("keeps in-flight tools running only while the turn is live", () => {
	const live = buildTurns(
		[
			user("read it", 1),
			assistant([{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.ts" } }], 2),
		],
		undefined,
		[{ id: "t1", name: "read_file", args: { path: "a.ts" }, status: "running", startedAt: 2 }],
		true,
	);
	expect(live[0]?.streaming).toBe(true);
	expect(live[0]?.work[0]?.status).toBe("running");
});

test("settles tools that never got a result after the agent stops", () => {
	const turns = buildTurns([
		user("read it", 1),
		assistant([{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.ts" } }], 2),
	]);
	expect(turns[0]?.streaming).toBeFalsy();
	expect(turns[0]?.work[0]?.status).toBe("done");
	expect(turns[0]?.work[0]?.id).toBe("t1");
});

function toolResult(id: string, name: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

test("does not reopen a finished turn's work log when the next run starts before its user message is in the transcript", () => {
	const turns = buildTurns(
		[
			user("map the project", 1),
			assistant([{ type: "toolCall", id: "t1", name: "list_dir", arguments: { path: "." } }], 2),
			toolResult("t1", "list_dir", "f  src", 3),
			assistant([{ type: "text", text: "Here is the layout." }], 4),
		],
		undefined,
		[{ id: "t1", name: "list_dir", args: { path: "." }, status: "done", startedAt: 2 }],
		true,
	);
	expect(turns).toHaveLength(1);
	expect(turns[0]?.streaming).toBeFalsy();
	expect(turns[0]?.work).toHaveLength(1);
	expect(turns[0]?.answer).toBe("Here is the layout.");
});

test("does not attach the previous run's tool activities to the next user turn", () => {
	const turns = buildTurns(
		[
			user("map the project", 1),
			assistant([{ type: "toolCall", id: "t1", name: "list_dir", arguments: { path: "." } }], 2),
			toolResult("t1", "list_dir", "f  src", 3),
			assistant([{ type: "text", text: "Here is the layout." }], 4),
			user("now fix the header", 5),
		],
		undefined,
		[{ id: "t1", name: "list_dir", args: { path: "." }, status: "done", startedAt: 2 }],
		true,
	);
	expect(turns).toHaveLength(2);
	expect(turns[0]?.streaming).toBeFalsy();
	expect(turns[1]?.streaming).toBe(true);
	expect(turns[1]?.user).toBe("now fix the header");
	expect(turns[1]?.work).toHaveLength(0);
});

test("keeps a tool turn live after results while the same run continues", () => {
	const turns = buildTurns(
		[
			user("look around", 1),
			assistant([{ type: "toolCall", id: "t1", name: "list_dir", arguments: { path: "." } }], 2),
			toolResult("t1", "list_dir", "f  src", 3),
		],
		undefined,
		[{ id: "t1", name: "list_dir", args: { path: "." }, status: "done", startedAt: 2 }],
		true,
	);
	expect(turns[0]?.streaming).toBe(true);
	expect(turns[0]?.work[0]?.status).toBe("done");
});

test("merges new tool activity into the current user turn only", () => {
	const turns = buildTurns(
		[
			user("map the project", 1),
			assistant([{ type: "toolCall", id: "t1", name: "list_dir", arguments: { path: "." } }], 2),
			toolResult("t1", "list_dir", "f  src", 3),
			assistant([{ type: "text", text: "Here is the layout." }], 4),
			user("read App.tsx", 5),
		],
		undefined,
		[
			{ id: "t1", name: "list_dir", args: { path: "." }, status: "done", startedAt: 2 },
			{ id: "t2", name: "read_file", args: { path: "src/ui/App.tsx" }, status: "running", startedAt: 6 },
		],
		true,
	);
	expect(turns[1]?.streaming).toBe(true);
	expect(turns[1]?.work.map((entry) => entry.id)).toEqual(["t2"]);
	expect(turns[1]?.work[0]?.label).toBe("Read file");
});

test("presents ask_user_question as a compact prompt", () => {
	expect(presentTool("ask_user_question", {
		questions: [
			{ header: "Auth", question: "Which auth?" },
			{ header: "Tests", question: "Which tests?" },
		],
	})).toEqual({
		kind: "other",
		label: "Asked you",
		detail: "Auth · 2 questions",
	});
	expect(presentTool("ask_user_question", { questions: [{ header: "Auth" }] }, "User declined to answer questions")).toMatchObject({
		detail: "Skipped",
	});
});

test("presents todo_write as a compact plan update", () => {
	expect(presentTool("todo_write", { todos: [{ content: "A" }, { content: "B" }] }, "2 tasks · 2 pending\n#1 [pending] A")).toEqual({
		kind: "other",
		label: "Updated tasks",
		detail: "2 tasks · 2 pending",
	});
	expect(presentTool("todo_write", { todos: [] }, "Cleared the task list.")).toMatchObject({
		kind: "other",
		detail: "Cleared the task list.",
	});
});

test("hides transient task reminders from the chat transcript", () => {
	const turns = buildTurns([
		user("fix auth", 1),
		assistant([{ type: "text", text: "On it." }], 2),
		{
			role: "user",
			content: "<system-reminder>\nThe task list has not been updated recently.\n</system-reminder>",
			timestamp: 3,
		},
		assistant([{ type: "text", text: "Continuing." }], 4),
	]);
	expect(turns.some((turn) => turn.user?.includes("system-reminder"))).toBe(false);
	expect(turns.at(-1)?.answer).toBe("Continuing.");
});
