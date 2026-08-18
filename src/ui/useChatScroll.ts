import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const AWAY_PX = 160;

/**
 * Follow new output only while the user is near the latest message.
 * Expanding a tool must not count as leaving the bottom.
 */
export function useChatScroll(containerRef: RefObject<HTMLElement | null>, followKey: unknown) {
	const pinned = useRef(true);
	const suppress = useRef(0);
	const programmatic = useRef(false);
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

	const scrollToEnd = (force = false) => {
		const element = containerRef.current;
		if (!element) return;
		if (!force && (suppress.current > 0 || !pinned.current)) return;
		programmatic.current = true;
		element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
		requestAnimationFrame(() => {
			programmatic.current = false;
			if (force || pinned.current) setShowLatest(false);
		});
	};

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		const onScroll = () => {
			if (programmatic.current || suppress.current > 0) return;
			syncFromPosition();
		};
		const onInspectWork = (event: Event) => {
			const target = event.target as HTMLElement | null;
			if (!target?.closest(".work-row-toggle, .work-more, .work-summary")) return;
			suppress.current += 1;
			setShowLatest(false);
			window.setTimeout(() => {
				suppress.current = Math.max(0, suppress.current - 1);
				if (distanceFromEnd() <= AWAY_PX) {
					pinned.current = true;
					setShowLatest(false);
				} else if (suppress.current === 0) {
					syncFromPosition();
				}
			}, 450);
		};

		element.addEventListener("scroll", onScroll, { passive: true });
		element.addEventListener("pointerdown", onInspectWork, { passive: true });
		return () => {
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("pointerdown", onInspectWork);
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
			if (suppress.current > 0) {
				setShowLatest(false);
				return;
			}
			scrollToEnd();
		});
		observer.observe(target);
		return () => observer.disconnect();
	}, [containerRef]);

	return {
		showLatest,
		jumpToLatest: () => {
			pinned.current = true;
			setShowLatest(false);
			scrollToEnd(true);
		},
		pin: () => {
			pinned.current = true;
			setShowLatest(false);
		},
	};
}
