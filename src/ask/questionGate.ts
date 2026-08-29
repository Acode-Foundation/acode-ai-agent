import { Signal } from "../core/events";
import type { QuestionAnswer, QuestionData, QuestionnairePrompt, QuestionnaireResult } from "./types";

export class QuestionGate {
	readonly changes = new Signal<QuestionnairePrompt | undefined>();
	#pending?: { prompt: QuestionnairePrompt; resolve: (result: QuestionnaireResult) => void };

	get pending(): QuestionnairePrompt | undefined {
		return this.#pending?.prompt;
	}

	async ask(questions: QuestionData[], signal?: AbortSignal): Promise<QuestionnaireResult> {
		if (signal?.aborted) return { answers: [], cancelled: true };
		if (this.#pending) return { answers: [], cancelled: true, error: "busy" };

		return new Promise((resolve) => {
			const abort = () => this.cancel();
			const finish = (result: QuestionnaireResult) => {
				signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			this.#pending = {
				prompt: {
					id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
					questions,
				},
				resolve: finish,
			};
			this.changes.emit(this.#pending.prompt);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}

	submit(answers: QuestionAnswer[]): void {
		this.#settle({ answers, cancelled: false });
	}

	cancel(): void {
		this.#settle({ answers: [], cancelled: true });
	}

	dispose(): void {
		this.cancel();
		this.changes.clear();
	}

	#settle(result: QuestionnaireResult): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		this.changes.emit(undefined);
		pending.resolve(result);
	}
}
