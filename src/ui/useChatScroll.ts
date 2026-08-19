import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { COLLAPSE_MOTION_EVENT } from "./Collapse";

const AWAY_PX = 160;

/**
 * Follow new output only while the user is near the latest message.
 * Expanding a work log must not yank the thread to keep the new bottom in view.
 */
export function useChatScroll(containerRef: RefObject<HTMLElement | null>, followKey: unknown) {
	const pinned = useRef(true);
	const suppress = useRef(0);
	const programmatic = useRef(false);
	const jumpTimer = useRef(0);
	const [showLatest, setShowLatest] = useState(false);

	const distanceFromEnd = () => {
		const element = containerRef.current;
		if (!element) return 0;
		return element.scrollHeight - element.scrollTop - element.clientHeight;
	};

	const syncFromPosition = () => {
		const away = distanceFromEnd() > AWAY_PX;
		if (suppress.current > 0) {
			setShowLatest(false);
			return;
		}
		pinned.current = !away;
		setShowLatest(away);
	};

	const scrollToEnd = (force = false, smooth = false) => {
		const element = containerRef.current;
		if (!element) return;
		if (!force && (suppress.current > 0 || !pinned.current)) return;
		const top = Math.max(0, element.scrollHeight - element.clientHeight);
		const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		programmatic.current = true;
		const finish = () => {
			programmatic.current = false;
			if (force || pinned.current) setShowLatest(false);
		};
		if (smooth && !reduce) {
			element.scrollTo({ top, behavior: "smooth" });
			window.clearTimeout(jumpTimer.current);
			jumpTimer.current = window.setTimeout(finish, 420);
			return;
		}
		element.scrollTop = top;
		requestAnimationFrame(finish);
	};

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		const onScroll = () => {
			if (programmatic.current || suppress.current > 0) return;
			syncFromPosition();
		};
		const onCollapse = (event: Event) => {
			const phase = (event as CustomEvent<{ phase?: "start" | "end" }>).detail?.phase;
			if (phase === "start") {
				suppress.current += 1;
				return;
			}
			if (phase !== "end") return;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					suppress.current = Math.max(0, suppress.current - 1);
					if (suppress.current === 0) syncFromPosition();
				});
			});
		};

		element.addEventListener("scroll", onScroll, { passive: true });
		element.addEventListener(COLLAPSE_MOTION_EVENT, onCollapse);
		return () => {
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener(COLLAPSE_MOTION_EVENT, onCollapse);
			window.clearTimeout(jumpTimer.current);
		};
	}, [containerRef]);

	useEffect(() => {
		scrollToEnd();
	}, [followKey]);

	useEffect(() => {
		const element = containerRef.current;
		const target = element?.firstElementChild ?? element;
		if (!element || !target) return;
		const observer = new ResizeObserver(() => {
			if (suppress.current > 0) return;
			scrollToEnd();
		});
		observer.observe(target);
		return () => observer.disconnect();
	}, [containerRef]);

	return {
		showLatest,
		jumpToLatest: () => {
			pinned.current = true;
			scrollToEnd(true, true);
		},
		pin: () => {
			pinned.current = true;
			setShowLatest(false);
		},
	};
}
