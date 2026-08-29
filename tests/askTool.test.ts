import { expect, test } from "vitest";
import { createAskTool } from "../src/ask/createAskTool.ts";
import { QuestionGate } from "../src/ask/questionGate.ts";
import { ASK_TOOL_NAME } from "../src/ask/types.ts";
import { DECLINE_MESSAGE } from "../src/ask/response.ts";

const questions = [{
	question: "Which cache?",
	header: "Cache",
	options: [
		{ label: "Memory (Recommended)", description: "Fast, process-local" },
		{ label: "Redis", description: "Shared across instances" },
	],
}];

test("ask_user_question waits for a structured answer", async () => {
	const gate = new QuestionGate();
	const tool = createAskTool(gate);
	expect(tool.name).toBe(ASK_TOOL_NAME);
	const pending = tool.execute("q1", { questions });
	await Promise.resolve();
	expect(gate.pending?.questions[0]?.header).toBe("Cache");
	gate.submit([{
		questionIndex: 0,
		question: "Which cache?",
		kind: "option",
		answer: "Redis",
	}]);
	const result = await pending;
	expect(result.content[0]).toMatchObject({
		type: "text",
		text: expect.stringContaining('"Which cache?"="Redis"'),
	});
	expect(gate.pending).toBeUndefined();
});

test("ask_user_question declines when the user skips or the run aborts", async () => {
	const gate = new QuestionGate();
	const tool = createAskTool(gate);
	const skipped = tool.execute("q2", { questions });
	await Promise.resolve();
	gate.cancel();
	expect((await skipped).content[0]).toEqual({ type: "text", text: DECLINE_MESSAGE });

	const abort = new AbortController();
	const aborted = tool.execute("q3", { questions }, abort.signal);
	await Promise.resolve();
	abort.abort();
	expect((await aborted).content[0]).toEqual({ type: "text", text: DECLINE_MESSAGE });
});

test("ask_user_question rejects invalid questionnaires without opening the UI", async () => {
	const gate = new QuestionGate();
	const tool = createAskTool(gate);
	const result = await tool.execute("q4", {
		questions: [{ question: "A?", header: "A", options: [{ label: "Only", description: "Nope" }] }],
	});
	expect(gate.pending).toBeUndefined();
	expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Error:") });
});
