export const ASK_TOOL_NAME = "ask_user_question";
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
export const MAX_PREVIEW_CHARS = 400;

export const RESERVED_LABELS = ["Other", "Type something.", "Next"] as const;

export type QuestionOption = {
	label: string;
	description: string;
	preview?: string;
};

export type QuestionData = {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
};

export type QuestionAnswer = {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	preview?: string;
};

export type QuestionnaireError =
	| "no_questions"
	| "too_many_questions"
	| "duplicate_question"
	| "empty_question"
	| "empty_options"
	| "too_many_options"
	| "reserved_label"
	| "duplicate_option_label"
	| "header_too_long"
	| "label_too_long"
	| "busy";

export type QuestionnaireResult = {
	answers: QuestionAnswer[];
	cancelled: boolean;
	error?: QuestionnaireError;
};

export type QuestionnairePrompt = {
	id: string;
	questions: QuestionData[];
};
