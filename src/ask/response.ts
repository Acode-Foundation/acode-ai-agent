import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { MAX_PREVIEW_CHARS, type QuestionAnswer, type QuestionnaireResult } from "./types";

export const DECLINE_MESSAGE = "User declined to answer questions";
const PREFIX = "User has answered your questions:";
const SUFFIX = "You can now continue with the user's answers in mind.";

export function buildQuestionnaireResponse(result: QuestionnaireResult): AgentToolResult<QuestionnaireResult> {
	if (result.cancelled || result.answers.length === 0) {
		return textResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true, ...(result.error ? { error: result.error } : {}) });
	}
	const segments = result.answers
		.slice()
		.sort((left, right) => left.questionIndex - right.questionIndex)
		.map(formatSegment)
		.filter(Boolean);
	if (!segments.length) return textResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	return textResult(`${PREFIX} ${segments.join(" ")} ${SUFFIX}`, result);
}

export function textResult(content: string, details: QuestionnaireResult): AgentToolResult<QuestionnaireResult> {
	return { content: [{ type: "text", text: content }], details };
}

function formatSegment(answer: QuestionAnswer): string {
	const value = formatAnswer(answer);
	if (!value) return "";
	const parts = [`"${answer.question}"="${value}"`];
	if (answer.preview?.trim()) parts.push(`selected preview: ${truncate(answer.preview.trim(), MAX_PREVIEW_CHARS)}`);
	return `${parts.join(". ")}.`;
}

function formatAnswer(answer: QuestionAnswer): string {
	if (answer.kind === "multi") return (answer.selected ?? []).map((item) => item.trim()).filter(Boolean).join(", ");
	return answer.answer?.trim() ?? "";
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}
