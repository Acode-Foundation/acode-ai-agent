import { Check, Copy } from "lucide-preact";
import { spring } from "motion";
import { useEffect, useRef, useState } from "preact/hooks";
import { playMotion, prefersReducedMotion } from "./motion";

export function playCopiedFeedback(element: HTMLElement): void {
	if (prefersReducedMotion()) return;
	void playMotion(
		element,
		{ transform: ["scale(0.92)", "scale(1)"] },
		{ type: spring, stiffness: 540, damping: 28, mass: 0.65 },
	);
}

export function swapCopyGlyphs(copy: HTMLElement, check: HTMLElement, copied: boolean): void {
	if (prefersReducedMotion()) {
		copy.style.opacity = copied ? "0" : "1";
		copy.style.transform = copied ? "scale(0.4)" : "scale(1)";
		check.style.opacity = copied ? "1" : "0";
		check.style.transform = copied ? "scale(1)" : "scale(0.4)";
		return;
	}
	if (copied) {
		void playMotion(copy, { opacity: 0, transform: "scale(0.4)" }, { duration: 0.12, ease: [0.4, 0, 1, 1] });
		void playMotion(check, { opacity: 1, transform: "scale(1)" }, { type: spring, stiffness: 560, damping: 26, mass: 0.65 });
		return;
	}
	void playMotion(copy, { opacity: 1, transform: "scale(1)" }, { type: spring, stiffness: 500, damping: 30 });
	void playMotion(check, { opacity: 0, transform: "scale(0.4)" }, { duration: 0.12, ease: [0.4, 0, 1, 1] });
}

export function CopyButton({ getText, label = "Copy" }: { getText: () => string; label?: string }) {
	const [copied, setCopied] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const copyIcon = useRef<HTMLSpanElement>(null);
	const checkIcon = useRef<HTMLSpanElement>(null);
	const primed = useRef(false);
	const timer = useRef<number | null>(null);
	useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
	useEffect(() => {
		const copy = copyIcon.current;
		const check = checkIcon.current;
		if (!copy || !check) return;
		if (!primed.current) {
			primed.current = true;
			return;
		}
		swapCopyGlyphs(copy, check, copied);
	}, [copied]);

	return (
		<button
			ref={button}
			type="button"
			class={`copy-btn${copied ? " copied" : ""}`}
			aria-label={copied ? "Copied" : label}
			title={copied ? "Copied" : label}
			onClick={async (event) => {
				event.preventDefault();
				const text = getText().trim();
				if (!text) return;
				await copyText(text);
				if (button.current) playCopiedFeedback(button.current);
				setCopied(true);
				if (timer.current !== null) window.clearTimeout(timer.current);
				timer.current = window.setTimeout(() => setCopied(false), 1400);
			}}
		>
			<span class="copy-icons" aria-hidden="true">
				<span ref={copyIcon} class="copy-icon"><Copy size={15} strokeWidth={2} /></span>
				<span ref={checkIcon} class="copy-icon is-check"><Check size={15} strokeWidth={2.2} /></span>
			</span>
		</button>
	);
}

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	}
}
