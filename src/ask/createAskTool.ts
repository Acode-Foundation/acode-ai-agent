import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { QuestionGate } from "./questionGate";
import { buildQuestionnaireResponse, textResult } from "./response";
import { ASK_TOOL_NAME, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./types";
import { parseQuestions, validateQuestionnaire } from "./validate";

const DESCRIPTION = [
	"Ask the user a structured choice instead of guessing. 1-4 questions, 2-4 options each, with a short label and a trade-off description.",
	"Users can pick options, type their own answer, or skip. Do not author Other or Type something. Put (Recommended) on your first option when you have a preference.",
	"Use multiSelect when several answers can apply. Optional preview (mockup or code) on single-select options. Group every clarifying question into one call.",
].join("\n");

export function createAskTool(gate: QuestionGate): AgentTool<any> {
	return {
		name: ASK_TOOL_NAME,
		label: "Ask user",
		description: DESCRIPTION,
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				question: Type.String({ description: "Full question, ending with ?" }),
				header: Type.String({ description: "Short chip, max 16 characters" }),
				options: Type.Array(Type.Object({
					label: Type.String({ description: "1-5 words, max 60 characters" }),
					description: Type.String({ description: "What this choice means or costs" }),
					preview: Type.Optional(Type.String({ description: "Optional mockup or code" })),
				}), { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
				multiSelect: Type.Optional(Type.Boolean({ description: "Allow more than one option" })),
			}), { minItems: 1, maxItems: MAX_QUESTIONS }),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const parsed = parseQuestions((params as { questions?: unknown }).questions);
			const validation = validateQuestionnaire(parsed);
			if (!validation.ok) return textResult(validation.message, { answers: [], cancelled: true, error: validation.error });
			const result = await gate.ask(validation.questions, signal);
			if (result.error === "busy") {
				return textResult("Error: a questionnaire is already waiting for the user.", result);
			}
			return buildQuestionnaireResponse(result);
		},
	};
}
