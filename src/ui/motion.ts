import { animate } from "motion/mini";
import { spring } from "motion";

type Keyframes = Parameters<typeof animate>[1];
type Options = Parameters<typeof animate>[2];

const playing = new WeakMap<Element, { stop: () => void }>();

export function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function stopMotion(element: Element): void {
	playing.get(element)?.stop();
	playing.delete(element);
}

export function playMotion(element: Element, keyframes: Keyframes, options?: Options): Promise<void> {
	stopMotion(element);
	if (prefersReducedMotion()) {
		applyInstant(element, keyframes);
		return Promise.resolve();
	}
	const animation = animate(element, keyframes, options);
	playing.set(element, animation);
	return Promise.resolve(animation).then(() => undefined).finally(() => {
		if (playing.get(element) === animation) playing.delete(element);
	});
}

function applyInstant(element: Element, keyframes: Keyframes): void {
	if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return;
	for (const [property, value] of Object.entries(keyframes as Record<string, unknown>)) {
		const latest = Array.isArray(value) ? value[value.length - 1] : value;
		if (latest === undefined) continue;
		if (property === "transform" || property === "opacity" || property === "height") {
			element.style.setProperty(property, String(latest));
		}
	}
}

export function enterSheet(dim: HTMLElement, sheet: HTMLElement): Promise<void> {
	if (prefersReducedMotion()) {
		dim.style.opacity = "1";
		sheet.style.transform = "none";
		return Promise.resolve();
	}
	const height = Math.max(sheet.getBoundingClientRect().height, 240);
	return Promise.all([
		playMotion(dim, { opacity: [0, 1] }, { duration: 0.22, ease: "easeOut" }),
		playMotion(
			sheet,
			{ transform: [`translateY(${height}px)`, "translateY(0px)"] },
			{ type: spring, visualDuration: 0.42, bounce: 0.06 },
		),
	]).then(() => undefined);
}

export function exitSheet(dim: HTMLElement, sheet: HTMLElement): Promise<void> {
	if (prefersReducedMotion()) return Promise.resolve();
	const height = Math.max(sheet.getBoundingClientRect().height, 240);
	return Promise.all([
		playMotion(dim, { opacity: 0 }, { duration: 0.18, ease: "easeIn" }),
		playMotion(sheet, { transform: `translateY(${Math.round(height * 1.04)}px)` }, { duration: 0.26, ease: [0.4, 0, 1, 1] }),
	]).then(() => undefined);
}

export function animateCollapse(element: HTMLElement, open: boolean): Promise<void> {
	stopMotion(element);
	element.style.overflow = "hidden";
	if (prefersReducedMotion()) {
		element.hidden = !open;
		element.style.height = open ? "" : "0px";
		element.style.opacity = "";
		if (open) element.style.overflow = "";
		return Promise.resolve();
	}
	if (open) {
		element.hidden = false;
		const start = element.getBoundingClientRect().height;
		element.style.height = "auto";
		const end = element.scrollHeight;
		element.style.height = `${start}px`;
		return playMotion(
			element,
			{ height: [`${start}px`, `${end}px`], opacity: [0.55, 1] },
			{ type: spring, visualDuration: 0.28, bounce: 0 },
		).then(() => {
			if (element.hidden) return;
			element.style.height = "";
			element.style.overflow = "";
			element.style.opacity = "";
		});
	}
	const start = element.getBoundingClientRect().height;
	return playMotion(
		element,
		{ height: [`${start}px`, "0px"], opacity: [1, 0.4] },
		{ duration: 0.2, ease: [0.4, 0, 1, 1] },
	).then(() => {
		element.hidden = true;
		element.style.opacity = "";
	});
}

export function animateHeight(element: HTMLElement, to: number, instant = false): Promise<void> {
	const from = element.getBoundingClientRect().height;
	if (instant || prefersReducedMotion() || Math.abs(from - to) < 0.5) {
		stopMotion(element);
		element.style.height = `${to}px`;
		return Promise.resolve();
	}
	return playMotion(
		element,
		{ height: [`${from}px`, `${to}px`] },
		{ type: spring, visualDuration: 0.22, bounce: 0 },
	);
}

export function rotateTo(element: HTMLElement, degrees: number, instant = false): Promise<void> {
	if (instant || prefersReducedMotion()) {
		stopMotion(element);
		element.style.transform = `rotate(${degrees}deg)`;
		return Promise.resolve();
	}
	return playMotion(
		element,
		{ transform: `rotate(${degrees}deg)` },
		{ type: spring, stiffness: 520, damping: 34, mass: 0.7 },
	);
}

export function fadeSlide(element: HTMLElement, visible: boolean, instant = false): Promise<void> {
	const hidden = "translateY(8px) scale(0.92)";
	const shown = "translateY(0px) scale(1)";
	if (instant || prefersReducedMotion()) {
		stopMotion(element);
		element.style.opacity = visible ? "1" : "0";
		element.style.transform = visible ? shown : hidden;
		return Promise.resolve();
	}
	return visible
		? playMotion(element, { opacity: 1, transform: shown }, { type: spring, visualDuration: 0.32, bounce: 0.12 })
		: playMotion(element, { opacity: 0, transform: hidden }, { duration: 0.18, ease: [0.4, 0, 1, 1] });
}

export function tapBounce(element: Element): Promise<void> {
	if (prefersReducedMotion()) return Promise.resolve();
	return playMotion(
		element,
		{ transform: ["scale(0.97)", "scale(1)"] },
		{ type: spring, visualDuration: 0.22, bounce: 0.28 },
	).then(() => {
		if (element instanceof HTMLElement) element.style.transform = "";
	});
}

export function slideInX(element: HTMLElement, direction: 1 | -1): Promise<void> {
	if (prefersReducedMotion()) {
		element.style.opacity = "";
		element.style.transform = "";
		return Promise.resolve();
	}
	return playMotion(
		element,
		{ opacity: [0.2, 1], transform: [`translateX(${direction * 22}px)`, "translateX(0px)"] },
		{ type: spring, visualDuration: 0.32, bounce: 0.05 },
	).then(() => {
		element.style.opacity = "";
		element.style.transform = "";
	});
}

export function springScaleX(element: HTMLElement, value: number): Promise<void> {
	if (prefersReducedMotion()) {
		element.style.transform = `scaleX(${value})`;
		return Promise.resolve();
	}
	return playMotion(element, { transform: `scaleX(${value})` }, { type: spring, visualDuration: 0.4, bounce: 0 });
}

export function fadeInUp(element: Element, delay = 0): Promise<void> {
	if (prefersReducedMotion()) {
		if (element instanceof HTMLElement) {
			element.style.opacity = "1";
			element.style.transform = "none";
		}
		return Promise.resolve();
	}
	return playMotion(
		element,
		{ opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
		{ duration: 0.26, ease: [0.16, 1, 0.3, 1], delay },
	).then(() => {
		if (element instanceof HTMLElement) {
			element.style.opacity = "";
			element.style.transform = "";
		}
	});
}
