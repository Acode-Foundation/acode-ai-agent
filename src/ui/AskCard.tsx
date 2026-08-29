import { Check, ChevronLeft, ChevronRight } from "lucide-preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { QuestionAnswer, QuestionData, QuestionnairePrompt } from "../ask/types";
import { backActionId, useBackAction } from "./actionStack";
import { Collapse } from "./Collapse";
import { fadeInUp, fadeSlide, slideInX, springScaleX, tapBounce } from "./motion";

type Draft = {
	selected: string[];
	custom: string;
	customOpen: boolean;
};

export function AskCard({
	prompt,
	onSubmit,
	onSkip,
}: {
	prompt: QuestionnairePrompt;
	onSubmit: (answers: QuestionAnswer[]) => void;
	onSkip: () => void;
}) {
	const root = useRef<HTMLElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLElement>(null);
	const steps = useRef<HTMLDivElement>(null);
	const skipBtn = useRef<HTMLButtonElement>(null);
	const primary = useRef<HTMLButtonElement>(null);
	const customRef = useRef<HTMLTextAreaElement>(null);
	const backId = useRef("");
	if (!backId.current) backId.current = backActionId("ask", true);
	const questions = prompt.questions;
	const [index, setIndex] = useState(0);
	const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(emptyDraft));
	const [confirmSkip, setConfirmSkip] = useState(false);
	const indexRef = useRef(0);
	const dirRef = useRef<1 | -1>(1);
	const ready = useRef(false);
	const settling = useRef(false);
	const advanceTimer = useRef(0);
	const couldContinue = useRef(false);

	const current = questions[index] ?? questions[0];
	const draft = drafts[index] ?? emptyDraft();
	const answered = useMemo(() => drafts.map((item, offset) => hasAnswer(questions[offset], item)), [drafts, questions]);
	const done = answered.filter(Boolean).length;
	const last = index >= questions.length - 1;
	const canContinue = Boolean(current && hasAnswer(current, draft));
	const allAnswered = questions.length > 0 && answered.every(Boolean);
	indexRef.current = index;

	useEffect(() => {
		setIndex(0);
		setDrafts(prompt.questions.map(emptyDraft));
		setConfirmSkip(false);
		ready.current = false;
		settling.current = false;
		couldContinue.current = false;
		window.clearTimeout(advanceTimer.current);
		const element = root.current;
		if (element) void fadeInUp(element);
	}, [prompt.id]);

	useLayoutEffect(() => {
		const element = panel.current;
		if (!element) return;
		if (!ready.current) {
			ready.current = true;
			return;
		}
		void slideInX(element, dirRef.current);
	}, [index]);

	useEffect(() => {
		const element = bar.current;
		if (element) void springScaleX(element, questions.length ? done / questions.length : 0);
	}, [done, questions.length]);

	useEffect(() => {
		const scroller = steps.current;
		const currentStep = scroller?.querySelector<HTMLElement>(".ask-step.current");
		if (!scroller || !currentStep) return;
		scroller.scrollTo({ left: currentStep.offsetLeft - scroller.clientWidth / 2 + currentStep.offsetWidth / 2, behavior: "smooth" });
	}, [index]);

	useEffect(() => {
		if (confirmSkip && skipBtn.current) void tapBounce(skipBtn.current);
	}, [confirmSkip]);

	useEffect(() => {
		if (canContinue && !couldContinue.current && primary.current) void tapBounce(primary.current);
		couldContinue.current = canContinue;
	}, [canContinue]);

	useEffect(() => () => window.clearTimeout(advanceTimer.current), []);

	const clearAdvance = () => window.clearTimeout(advanceTimer.current);

	const closeWith = (action: () => void) => {
		if (settling.current) return;
		settling.current = true;
		clearAdvance();
		const element = root.current;
		if (!element) {
			action();
			return;
		}
		void fadeSlide(element, false).then(action);
	};

	useBackAction(backId.current, () => {
		if (!confirmSkip) {
			setConfirmSkip(true);
			return;
		}
		closeWith(onSkip);
	});

	if (!current) return null;

	const patch = (update: Partial<Draft>) => {
		setConfirmSkip(false);
		setDrafts((currentDrafts) => currentDrafts.map((item, offset) => offset === index ? { ...item, ...update } : item));
	};

	const go = (next: number) => {
		const clamped = Math.max(0, Math.min(questions.length - 1, next));
		if (clamped === indexRef.current) return;
		clearAdvance();
		dirRef.current = clamped > indexRef.current ? 1 : -1;
		setConfirmSkip(false);
		setIndex(clamped);
	};

	const pick = (label: string, target: EventTarget | null) => {
		if (target instanceof HTMLElement) void tapBounce(target);
		clearAdvance();
		if (current.multiSelect) {
			const selected = draft.selected.includes(label)
				? draft.selected.filter((item) => item !== label)
				: [...draft.selected, label];
			patch({ selected });
			return;
		}
		patch({ selected: [label], customOpen: false, custom: "" });
		const option = current.options.find((item) => item.label === label);
		if (option?.preview || last) return;
		advanceTimer.current = window.setTimeout(() => go(indexRef.current + 1), 340);
	};

	const openCustom = (target: EventTarget | null) => {
		if (target instanceof HTMLElement) void tapBounce(target);
		clearAdvance();
		if (current.multiSelect) patch({ customOpen: !draft.customOpen });
		else patch({ selected: [], customOpen: true });
		queueMicrotask(() => customRef.current?.focus());
	};

	const continueOrSubmit = () => {
		if (!canContinue) return;
		if (last) {
			if (!allAnswered) {
				const firstOpen = answered.findIndex((item) => !item);
				if (firstOpen >= 0) go(firstOpen);
				return;
			}
			closeWith(() => onSubmit(toAnswers(questions, drafts)));
			return;
		}
		const nextOpen = answered.findIndex((item, offset) => offset > index && !item);
		go(nextOpen >= 0 ? nextOpen : index + 1);
	};

	const preview = !current.multiSelect && draft.selected[0]
		? current.options.find((option) => option.label === draft.selected[0])?.preview
		: undefined;

	return (
		<section ref={root} class="ask-card" role="dialog" aria-label="Agent question">
			<span class="ask-bar" aria-hidden="true">
				<i ref={bar} />
			</span>
			<header class="ask-head">
				{questions.length > 1 ? (
					<div class="ask-steps" ref={steps} role="tablist" aria-label="Questions">
						{questions.map((question, offset) => (
							<button
								key={`${prompt.id}-${offset}`}
								type="button"
								role="tab"
								aria-selected={offset === index}
								class={`ask-step${offset === index ? " current" : ""}`}
								onClick={(event) => {
									void tapBounce(event.currentTarget);
									go(offset);
								}}
							>
								{question.header || `Q${offset + 1}`}
							</button>
						))}
					</div>
				) : (
					<strong>{current.header || "Ask"}</strong>
				)}
				{questions.length > 1 && <span class="ask-count">{index + 1}/{questions.length}</span>}
				<button
					ref={skipBtn}
					type="button"
					class={confirmSkip ? "ask-skip warn" : "ask-skip"}
					onClick={() => {
						if (!confirmSkip) {
							setConfirmSkip(true);
							return;
						}
						closeWith(onSkip);
					}}
				>
					{confirmSkip ? "Skip?" : "Skip"}
				</button>
			</header>
			<div class="ask-body">
				<div class="ask-panel" ref={panel}>
					<p class="ask-question" aria-live="polite">{current.question}</p>
					{current.multiSelect && <p class="ask-hint">Choose any that apply</p>}
					<ul class="ask-options">
						{current.options.map((option) => {
							const selected = draft.selected.includes(option.label);
							return (
								<li key={option.label}>
									<button
										type="button"
										class={`ask-option${selected ? " selected" : ""}`}
										aria-pressed={selected}
										onClick={(event) => pick(option.label, event.currentTarget)}
									>
										<ChoiceMark multi={Boolean(current.multiSelect)} selected={selected} />
										<span>
											<strong>{option.label}</strong>
											<small>{option.description}</small>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
					<Collapse open={Boolean(preview)}>
						<pre class="ask-preview">{preview}</pre>
					</Collapse>
					<div class="ask-custom">
						<button
							type="button"
							class={`ask-option custom${draft.customOpen ? " selected" : ""}`}
							aria-pressed={draft.customOpen}
							onClick={(event) => openCustom(event.currentTarget)}
						>
							<ChoiceMark multi={false} selected={draft.customOpen} />
							<span>
								<strong>Type something</strong>
								<small>Answer in your own words</small>
							</span>
						</button>
						<Collapse open={draft.customOpen}>
							<textarea
								ref={customRef}
								rows={3}
								placeholder="Your answer"
								value={draft.custom}
								onInput={(event) => patch({ custom: (event.target as HTMLTextAreaElement).value, customOpen: true })}
							/>
						</Collapse>
					</div>
				</div>
			</div>
			<div class="ask-foot">
				{questions.length > 1 && (
					<button type="button" disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous question">
						<ChevronLeft size={16} strokeWidth={2} />
						Back
					</button>
				)}
				<button ref={primary} type="button" class="primary" disabled={!canContinue} onClick={continueOrSubmit}>
					{last ? "Submit" : "Continue"}
					{!last && <ChevronRight size={16} strokeWidth={2} />}
				</button>
			</div>
		</section>
	);
}

function ChoiceMark({ multi, selected }: { multi: boolean; selected: boolean }) {
	if (multi) {
		return (
			<span class={`ask-mark box${selected ? " on" : ""}`} aria-hidden="true">
				{selected ? <Check size={12} strokeWidth={2.6} /> : null}
			</span>
		);
	}
	return <span class={`ask-mark radio${selected ? " on" : ""}`} aria-hidden="true" />;
}

function emptyDraft(): Draft {
	return { selected: [], custom: "", customOpen: false };
}

function hasAnswer(question: QuestionData | undefined, draft: Draft | undefined): boolean {
	if (!question || !draft) return false;
	if (draft.customOpen && draft.custom.trim()) return true;
	return draft.selected.some((label) => question.options.some((option) => option.label === label));
}

function toAnswers(questions: QuestionData[], drafts: Draft[]): QuestionAnswer[] {
	const answers: QuestionAnswer[] = [];
	questions.forEach((question, questionIndex) => {
		const draft = drafts[questionIndex];
		if (!draft || !hasAnswer(question, draft)) return;
		const custom = draft.custom.trim();
		const selected = draft.selected.filter((label) => question.options.some((option) => option.label === label));
		if (question.multiSelect) {
			answers.push({
				questionIndex,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: custom && draft.customOpen ? [...selected, custom] : selected,
			});
			return;
		}
		if (draft.customOpen && custom) {
			answers.push({ questionIndex, question: question.question, kind: "custom", answer: custom });
			return;
		}
		const label = selected[0];
		if (!label) return;
		const preview = question.options.find((option) => option.label === label)?.preview;
		answers.push({
			questionIndex,
			question: question.question,
			kind: "option",
			answer: label,
			...(preview ? { preview } : {}),
		});
	});
	return answers;
}
