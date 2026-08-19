import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildTurns, formatWorkDuration, groupWorkEntries, parseDirListing, presentTool, splitReadOutput } from "../src/ui/transcript.ts";

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

	assert.equal(turns.length, 1);
	assert.equal(turns[0]?.user, "fix the header");
	assert.equal(turns[0]?.work[0]?.type, "thinking");
	assert.equal(turns[0]?.work[1]?.type, "note");
	assert.equal(turns[0]?.work[2]?.label, "Read file");
	assert.equal(turns[0]?.work[2]?.detail, "src/ui/App.tsx");
	assert.equal(turns[0]?.work[2]?.status, "done");
	assert.equal(turns[0]?.work[2]?.output, "export function App() {}");
	assert.equal(turns[0]?.answer, "The header is unused. I'll remove it.");
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
	assert.equal(turns[0]?.work[0]?.detail, "src/a.ts:1-2000 of 8432");
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
	assert.equal(turns[0]?.notice?.kind, "compaction");
	assert.equal(turns[0]?.notice?.text, "Earlier turns covered the header rewrite.");
	assert.equal(turns[1]?.user, "continue");
});

test("keeps a text-only reply as the answer with no work log", () => {
	const turns = buildTurns([
		user("hi"),
		assistant([{ type: "text", text: "Hello. Open a file and I can help." }]),
	]);
	assert.equal(turns[0]?.work.length, 0);
	assert.equal(turns[0]?.answer, "Hello. Open a file and I can help.");
});

test("labels common tools", () => {
	assert.deepEqual(presentTool("grep", { query: "TODO" }), { kind: "search", label: "Searched files", detail: "TODO" });
	assert.deepEqual(presentTool("edit_file", { path: "a.ts" }), { kind: "change", label: "Changed files", detail: "a.ts" });
	assert.deepEqual(presentTool("read_file", { path: "src/a.ts", offset: 10, limit: 31 }), {
		kind: "read",
		label: "Read file",
		detail: "src/a.ts:10-40",
	});
	assert.deepEqual(
		presentTool("read_file", { path: "src/a.ts" }, "[Showing lines 1-2000 of 8432. Use offset=2001 to continue.]\n\nalpha"),
		{ kind: "read", label: "Read file", detail: "src/a.ts:1-2000 of 8432" },
	);
});

test("splits the read truncation notice out of the file body", () => {
	assert.deepEqual(
		splitReadOutput("[Showing lines 1-2 of 9. Use offset=3 to continue.]\n\none\ntwo"),
		{ body: "one\ntwo", notice: "Showing lines 1-2 of 9. Use offset=3 to continue." },
	);
});

test("groups consecutive tools into one burst", () => {
	const groups = groupWorkEntries([
		{ id: "t1", type: "tool", kind: "read", name: "read_file", label: "Read file", status: "done" },
		{ id: "t2", type: "tool", kind: "search", name: "grep", label: "Searched files", status: "done" },
		{ id: "n1", type: "note", kind: "other", name: "note", label: "Note", status: "done", output: "ok" },
	]);
	assert.equal(groups[0]?.kind, "actions");
	assert.equal(groups[0] && groups[0].kind === "actions" ? groups[0].entries.length : 0, 2);
	assert.equal(groups[1]?.kind, "content");
});

test("formats short work durations", () => {
	assert.equal(formatWorkDuration(400), "under a second");
	assert.equal(formatWorkDuration(5_700), "6s");
	assert.equal(formatWorkDuration(12_000), "12s");
	assert.equal(formatWorkDuration(75_000), "1m 15s");
	assert.equal(formatWorkDuration(3_600_000), "1h");
	assert.equal(formatWorkDuration(3_721_000), "1h 2m");
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
	assert.equal(first[0]?.id, "user-10");
	assert.equal(second[0]?.id, first[0]?.id);
	assert.equal(second[0]?.work[0]?.id, "t1");
	assert.equal(second[0]?.work[1]?.id, "t2");
	assert.equal(second[0]?.streaming, true);
});

test("parses list_dir output into basenames without host class names", () => {
	const entries = parseDirListing("d  utils\nd  www\nf  package.json\nf  src/main.ts");
	assert.deepEqual(entries, [
		{ kind: "dir", name: "utils" },
		{ kind: "dir", name: "www" },
		{ kind: "file", name: "package.json" },
		{ kind: "file", name: "main.ts" },
	]);
	assert.equal(parseDirListing("Directory is empty.")?.length, 0);
});

test("keeps the last turn live while the run is active even without a streaming message", () => {
	const turns = buildTurns(
		[user("look around", 4)],
		undefined,
		[{ id: "t1", name: "list_dir", args: { path: "." }, status: "running", startedAt: 5 }],
		true,
	);
	assert.equal(turns[0]?.streaming, true);
	assert.equal(turns[0]?.work[0]?.id, "t1");
	assert.equal(turns[0]?.work[0]?.label, "Listed folder");
});
