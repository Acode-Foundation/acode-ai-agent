import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { animateCollapse, rotateTo } from "./motion";

export const COLLAPSE_MOTION_EVENT = "acode-agent-collapse";

function emitCollapse(element: HTMLElement, phase: "start" | "end"): void {
	element.dispatchEvent(new CustomEvent(COLLAPSE_MOTION_EVENT, { bubbles: true, detail: { phase } }));
}

export function Collapse({ open, children }: { open: boolean; children: ComponentChildren }) {
	const ref = useRef<HTMLDivElement>(null);
	const ready = useRef(false);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		if (!ready.current) {
			ready.current = true;
			if (!open) {
				element.hidden = true;
				element.style.height = "0px";
				element.style.overflow = "hidden";
			}
			return;
		}
		emitCollapse(element, "start");
		void animateCollapse(element, open).finally(() => emitCollapse(element, "end"));
	}, [open]);

	return (
		<div ref={ref} class="motion-collapse">
			{children}
		</div>
	);
}

export function RotateIcon({
	open,
	degrees = 90,
	class: className,
	children,
}: {
	open: boolean;
	degrees?: number;
	class?: string;
	children: ComponentChildren;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const ready = useRef(false);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		void rotateTo(element, open ? degrees : 0, !ready.current);
		ready.current = true;
	}, [open, degrees]);

	return (
		<span ref={ref} class={className} aria-hidden="true">
			{children}
		</span>
	);
}
