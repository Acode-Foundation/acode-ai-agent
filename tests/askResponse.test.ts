import { expect, test } from "vitest";
import { buildQuestionnaireResponse, DECLINE_MESSAGE } from "../src/ask/response.ts";

test("formats answered questions without dumping previews wholesale", () => {
	const result = buildQuestionnaireResponse({
		cancelled: false,
		answers: [
			{ questionIndex: 0, question: "Which auth?", kind: "option", answer: "JWT (Recommended)", preview: "token in header" },
			{ questionIndex: 1, question: "Which tests?", kind: "multi", answer: null, selected: ["Unit", "E2E"] },
			{ questionIndex: 2, question: "Name?", kind: "custom", answer: "Acme" },
		],
	});
	expect(result.content[0]).toEqual({
		type: "text",
		text: 'User has answered your questions: "Which auth?"="JWT (Recommended)". selected preview: token in header. "Which tests?"="Unit, E2E". "Name?"="Acme". You can now continue with the user\'s answers in mind.',
	});
});

test("treats skip and empty answers as a single decline", () => {
	expect(buildQuestionnaireResponse({ answers: [], cancelled: true }).content[0]).toEqual({
		type: "text",
		text: DECLINE_MESSAGE,
	});
	expect(buildQuestionnaireResponse({ answers: [], cancelled: false }).content[0]).toEqual({
		type: "text",
		text: DECLINE_MESSAGE,
	});
});
