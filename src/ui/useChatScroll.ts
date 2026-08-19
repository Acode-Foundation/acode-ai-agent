import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { COLLAPSE_MOTION_EVENT } from "./Collapse";

const AWAY_PX = 160;
const AT_END_PX = 24;
const KEYBOARD_HOLD_MS = 560;

export type ThreadSnapshot = {
	scrollTop: number;
	fromEnd: number;
	atEnd: boolean;
};

export function readThreadSnapshot(scrollHeight: number, scrollTop: number, clientHeight: number): ThreadSnapshot {
	const fromEnd = scrollHeight - scrollTop - clientHeight;
	return { scrollTop, fromEnd, atEnd: fromEnd <= AT_END_PX };
}

export function scrollTopAfterViewport(snapshot: ThreadSnapshot, scrollHeight: number, clientHeight: number): number {
	if (snapshot.atEnd) return Math.max(0, scrollHeight - clientHeight);
	return snapshot.scrollTop;
}

function snapshotOf(element: HTMLElement): ThreadSnapshot {
	return readThreadSnapshot(element.scrollHeight, element.scrollTop, element.clientHeight);
}

function getAcodeKeyboard(): Acode.Keyboard | undefined {
	try {
		if (typeof acode === "undefined") return undefined;
		return acode.require("keyboard");
	} catch {
		return undefined;
	}
}

/**
 * Follow new output only while the user is near the latest message.
 * Expanding a work log must not yank the thread to keep the new bottom in view.
 * Soft-keyboard resize uses Acode's keyboard show/hide cycle: freeze the last
 * user-chosen offset, then restore it. Only an at-the-bottom thread stays pinned.
 */
export function useChatScroll(containerRef: RefObject<HTMLElement | null>, followKey: unknown) {
	const pinned = useRef(true);
	const suppress = useRef(0);
	const viewportLock = useRef(0);
	const programmatic = useRef(false);
	const jumpTimer = useRef(0);
	const holdTimer = useRef(0);
	const lastHeight = useRef(0);
	const lastUser = useRef<ThreadSnapshot | null>(null);
	const pending = useRef<ThreadSnapshot | null>(null);
	const composerArmed = useRef(false);
	const [showLatest, setShowLatest] = useState(false);

	const distanceFromEnd = () => {
		const element = containerRef.current;
		if (!element) return 0;
		return element.scrollHeight - element.scrollTop - element.clientHeight;
	};

	const rememberUser = () => {
		const element = containerRef.current;
		if (!element) return;
		lastUser.current = snapshotOf(element);
	};

	const applySnapshot = (snapshot: ThreadSnapshot) => {
		const element = containerRef.current;
		if (!element) return;
		programmatic.current = true;
		element.scrollTop = scrollTopAfterViewport(snapshot, element.scrollHeight, element.clientHeight);
		lastHeight.current = element.clientHeight;
		pinned.current = snapshot.atEnd;
		setShowLatest(!snapshot.atEnd);
		requestAnimationFrame(() => {
			programmatic.current = false;
		});
	};

	const freezeThread = () => {
		if (pending.current) return;
		const element = containerRef.current;
		pending.current = lastUser.current ?? (element ? snapshotOf(element) : null);
	};

	const restoreThread = () => {
		if (pending.current) applySnapshot(pending.current);
	};

	const captureThread = () => {
		composerArmed.current = true;
		freezeThread();
	};

	const releaseKeyboard = () => {
		if (!composerArmed.current && !pending.current) return;
		restoreThread();
		window.clearTimeout(holdTimer.current);
		holdTimer.current = window.setTimeout(() => {
			viewportLock.current = 0;
			composerArmed.current = false;
			pending.current = null;
			rememberUser();
			if (pinned.current) {
				const element = containerRef.current;
				if (element) {
					programmatic.current = true;
					element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
					lastUser.current = snapshotOf(element);
					requestAnimationFrame(() => {
						programmatic.current = false;
					});
				}
				setShowLatest(false);
				return;
			}
			const away = distanceFromEnd() > AWAY_PX;
			pinned.current = !away;
			setShowLatest(away);
			rememberUser();
		}, KEYBOARD_HOLD_MS);
	};

	const syncFromPosition = () => {
		const away = distanceFromEnd() > AWAY_PX;
		if (suppress.current > 0 || viewportLock.current > 0) return;
		pinned.current = !away;
		setShowLatest(away);
		rememberUser();
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
			lastHeight.current = element.clientHeight;
			if (force || pinned.current) {
				setShowLatest(false);
				rememberUser();
			}
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
		lastHeight.current = element.clientHeight;
		rememberUser();

		const onScroll = () => {
			if (programmatic.current || suppress.current > 0 || viewportLock.current > 0) return;
			if (lastHeight.current > 0 && element.clientHeight !== lastHeight.current) return;
			pending.current = null;
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
			window.clearTimeout(holdTimer.current);
		};
	}, [containerRef]);

	useEffect(() => {
		scrollToEnd();
	}, [followKey]);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		lastHeight.current = element.clientHeight;
		if (!lastUser.current) rememberUser();

		const onViewport = () => {
			const height = element.clientHeight;
			const viewportChanged = lastHeight.current > 0 && height !== lastHeight.current;
			lastHeight.current = height;
			if (suppress.current > 0 || !viewportChanged) return;
			if (!composerArmed.current && !pending.current) {
				if (pinned.current && lastUser.current?.atEnd) scrollToEnd();
				return;
			}
			freezeThread();
			viewportLock.current = 1;
			restoreThread();
			releaseKeyboard();
		};

		const onContent = () => {
			if (suppress.current > 0 || viewportLock.current > 0) return;
			scrollToEnd();
		};

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === element) onViewport();
				else onContent();
			}
		});
		observer.observe(element);
		const content = element.firstElementChild;
		if (content) observer.observe(content);

		const keyboard = getAcodeKeyboard();
		const onShowStart = () => {
			if (!composerArmed.current) return;
			freezeThread();
			viewportLock.current = 1;
		};
		const onShow = () => {
			if (!composerArmed.current && !pending.current) return;
			restoreThread();
			releaseKeyboard();
		};
		const onHideStart = () => {
			if (!composerArmed.current && !pending.current) return;
			viewportLock.current = 1;
			restoreThread();
		};
		const onHide = () => {
			if (!composerArmed.current && !pending.current) return;
			restoreThread();
			releaseKeyboard();
		};
		keyboard?.on("keyboardShowStart", onShowStart);
		keyboard?.on("keyboardShow", onShow);
		keyboard?.on("keyboardHideStart", onHideStart);
		keyboard?.on("keyboardHide", onHide);

		return () => {
			observer.disconnect();
			keyboard?.off("keyboardShowStart", onShowStart);
			keyboard?.off("keyboardShow", onShow);
			keyboard?.off("keyboardHideStart", onHideStart);
			keyboard?.off("keyboardHide", onHide);
		};
	}, [containerRef]);

	return {
		showLatest,
		jumpToLatest: () => {
			pinned.current = true;
			pending.current = null;
			composerArmed.current = false;
			scrollToEnd(true, true);
		},
		pin: () => {
			pinned.current = true;
			setShowLatest(false);
		},
		captureThread,
	};
}
