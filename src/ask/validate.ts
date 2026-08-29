import {
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	RESERVED_LABELS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionOption,
} from "./types";

const RESERVED = new Set<string>(RESERVED_LABELS);

export type ValidationResult = { ok: true; questions: QuestionData[] } | { ok: false; error: QuestionnaireError; message: string };

export function parseQuestions(raw: unknown): QuestionData[] {
	if (!Array.isArray(raw)) return [];
	const questions: QuestionData[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const value = item as Record<string, unknown>;
		const options: QuestionOption[] = [];
		if (Array.isArray(value.options)) {
			for (const option of value.options) {
				if (!option || typeof option !== "object") continue;
				const entry = option as Record<string, unknown>;
				const label = typeof entry.label === "string" ? entry.label.trim() : "";
				const description = typeof entry.description === "string" ? entry.description.trim() : "";
				const preview = typeof entry.preview === "string" && entry.preview.trim() ? entry.preview : undefined;
				options.push({ label, description, ...(preview ? { preview } : {}) });
			}
		}
		questions.push({
			question: typeof value.question === "string" ? value.question.trim() : "",
			header: typeof value.header === "string" ? value.header.trim() : "",
			options,
			...(value.multiSelect === true ? { multiSelect: true } : {}),
		});
	}
	return questions;
}

export function validateQuestionnaire(questions: QuestionData[]): ValidationResult {
	if (questions.length === 0) return fail("no_questions", "Error: need 1-4 questions.");
	if (questions.length > MAX_QUESTIONS) return fail("too_many_questions", "Error: need 1-4 questions.");

	const seenQuestions = new Set<string>();
	for (const question of questions) {
		if (!question.question) return fail("empty_question", "Error: each question needs question text.");
		if (seenQuestions.has(question.question)) return fail("duplicate_question", "Error: question text must be unique.");
		seenQuestions.add(question.question);
		if (question.header.length > MAX_HEADER_LENGTH) {
			return fail("header_too_long", `Error: header must be at most ${MAX_HEADER_LENGTH} characters.`);
		}
		if (question.options.length < MIN_OPTIONS) {
			return fail("empty_options", `Error: each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
		}
		if (question.options.length > MAX_OPTIONS) {
			return fail("too_many_options", `Error: each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
		}
		const seenLabels = new Set<string>();
		for (const option of question.options) {
			if (!option.label || !option.description) {
				return fail("empty_options", "Error: each option needs a label and a description.");
			}
			if (RESERVED.has(option.label)) {
				return fail("reserved_label", `Error: option label is reserved (${RESERVED_LABELS.join(", ")}).`);
			}
			if (option.label.length > MAX_LABEL_LENGTH) {
				return fail("label_too_long", `Error: option labels must be at most ${MAX_LABEL_LENGTH} characters.`);
			}
			if (seenLabels.has(option.label)) {
				return fail("duplicate_option_label", "Error: option labels must be unique within a question.");
			}
			seenLabels.add(option.label);
		}
	}
	return { ok: true, questions };
}

function fail(error: QuestionnaireError, message: string): ValidationResult {
	return { ok: false, error, message };
}
