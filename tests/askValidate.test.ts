import { expect, test } from "vitest";
import { parseQuestions, validateQuestionnaire } from "../src/ask/validate.ts";

const option = (label: string, description = `${label} path`) => ({ label, description });

test("parses and accepts a compact questionnaire", () => {
	const questions = parseQuestions([{
		question: "Which auth should we use?",
		header: "Auth",
		options: [option("JWT (Recommended)"), option("Sessions")],
	}]);
	const result = validateQuestionnaire(questions);
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.questions[0]?.options).toHaveLength(2);
});

test("rejects reserved labels, duplicates, and over-long headers", () => {
	expect(validateQuestionnaire(parseQuestions([])).error).toBe("no_questions");
	expect(validateQuestionnaire(parseQuestions([
		{ question: "A?", header: "A", options: [option("Yes"), option("No")] },
		{ question: "A?", header: "B", options: [option("Yes"), option("No")] },
	])).error).toBe("duplicate_question");
	expect(validateQuestionnaire(parseQuestions([{
		question: "A?",
		header: "Auth",
		options: [option("Other"), option("Sessions")],
	}])).error).toBe("reserved_label");
	expect(validateQuestionnaire(parseQuestions([{
		question: "A?",
		header: "This header is way too long",
		options: [option("Yes"), option("No")],
	}])).error).toBe("header_too_long");
	expect(validateQuestionnaire(parseQuestions([{
		question: "A?",
		header: "A",
		options: [option("Yes"), option("Yes")],
	}])).error).toBe("duplicate_option_label");
	expect(validateQuestionnaire(parseQuestions([{
		question: "A?",
		header: "A",
		options: [option("Only")],
	}])).error).toBe("empty_options");
});
