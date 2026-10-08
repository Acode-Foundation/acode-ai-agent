import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { COLLAPSE_MOTION_EVENT } from "./Collapse";

const AWAY_PX = 160;
const AT_END_PX = 24;
const KEYBOARD_HOLD_MS = 560;
/** Longer than any expand/collapse spring, so a lost end event only pauses following briefly. */
const COLLAPSE_FALLBACK_MS = 900;
/** A tap this close before an expand/collapse means the user started it. */
const USER_MOTION_MS = 400;

export type MotionGate = {
  readonly busy: boolean;
  start: (target: EventTarget) => void;
  end: (target: EventTarget) => void;
  dispose: () => void;
};

/**
 * Tracks running expand/collapse animations, which pause following. An interrupted animation
 * (motion's stop() never settles its promise) or one whose row unmounts mid-flight never
 * reports its end, so each animation also releases itself after a fallback delay.
 */
export function createMotionGate(
  onIdle: () => void,
  fallbackMs = COLLAPSE_FALLBACK_MS,
): MotionGate {
  const active = new Map<EventTarget, ReturnType<typeof setTimeout>>();
  const end = (target: EventTarget) => {
    const timer = active.get(target);
    if (timer === undefined) return;
    clearTimeout(timer);
    active.delete(target);
    if (!active.size) onIdle();
  };
  return {
    get busy() {
      return active.size > 0;
    },
    start(target) {
      clearTimeout(active.get(target));
      active.set(
        target,
        setTimeout(() => end(target), fallbackMs),
      );
    },
    end,
    dispose() {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    },
  };
}

export type ThreadSnapshot = {
  scrollTop: number;
  fromEnd: number;
  atEnd: boolean;
};

export function readThreadSnapshot(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): ThreadSnapshot {
  const fromEnd = scrollHeight - scrollTop - clientHeight;
  return { scrollTop, fromEnd, atEnd: fromEnd <= AT_END_PX };
}

export function scrollTopAfterViewport(
  snapshot: ThreadSnapshot,
  scrollHeight: number,
  clientHeight: number,
): number {
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
  const gate = useRef<MotionGate | null>(null);
  const viewportLock = useRef(0);
  const programmatic = useRef(false);
  const jumpTimer = useRef(0);
  const holdTimer = useRef(0);
  const lastHeight = useRef(0);
  const lastUser = useRef<ThreadSnapshot | null>(null);
  const lastInput = useRef(0);
  const motionSince = useRef(0);
  const pending = useRef<ThreadSnapshot | null>(null);
  const composerArmed = useRef(false);
  const [showLatest, setShowLatest] = useState(false);

  const animating = () => gate.current?.busy === true;

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
    element.scrollTop = scrollTopAfterViewport(
      snapshot,
      element.scrollHeight,
      element.clientHeight,
    );
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
    if (animating() || viewportLock.current > 0) return;
    pinned.current = !away;
    setShowLatest(away);
    rememberUser();
  };

  const scrollToEnd = (force = false, smooth = false) => {
    const element = containerRef.current;
    if (!element) return;
    if (!force && (animating() || !pinned.current)) return;
    const top = Math.max(0, element.scrollHeight - element.clientHeight);
    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      if (programmatic.current || animating() || viewportLock.current > 0) return;
      if (lastHeight.current > 0 && element.clientHeight !== lastHeight.current) return;
      pending.current = null;
      syncFromPosition();
    };
    // A row the user opened must not be yanked away, so their position decides; a row that
    // opened by itself (a failed tool, a row regrouping) keeps following if they were pinned.
    const motion = createMotionGate(() => {
      if (lastInput.current >= motionSince.current - USER_MOTION_MS) syncFromPosition();
      else scrollToEnd();
    });
    gate.current = motion;
    const onInput = () => {
      lastInput.current = performance.now();
    };
    const onCollapse = (event: Event) => {
      const phase = (event as CustomEvent<{ phase?: "start" | "end" }>).detail?.phase;
      const target = event.target;
      if (!target) return;
      if (phase === "start") {
        if (!motion.busy) motionSince.current = performance.now();
        motion.start(target);
        return;
      }
      if (phase !== "end") return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => motion.end(target));
      });
    };

    const inputs = ["pointerdown", "touchstart", "wheel", "keydown"] as const;
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener(COLLAPSE_MOTION_EVENT, onCollapse);
    for (const type of inputs) element.addEventListener(type, onInput, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener(COLLAPSE_MOTION_EVENT, onCollapse);
      for (const type of inputs) element.removeEventListener(type, onInput);
      window.clearTimeout(jumpTimer.current);
      window.clearTimeout(holdTimer.current);
      motion.dispose();
      gate.current = null;
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
      if (animating() || !viewportChanged) return;
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
      if (animating() || viewportLock.current > 0) return;
      scrollToEnd();
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) onViewport();
        else onContent();
      }
    });
    observer.observe(element);
    // The empty state is replaced by the thread on the first message, so watch whichever
    // children the container has now rather than the one it had at mount.
    const observed = new Set<Element>();
    const observeChildren = () => {
      for (const child of observed) {
        if (child.parentElement === element) continue;
        observer.unobserve(child);
        observed.delete(child);
      }
      for (const child of element.children) {
        if (observed.has(child)) continue;
        observer.observe(child);
        observed.add(child);
      }
    };
    observeChildren();
    const children = new MutationObserver(observeChildren);
    children.observe(element, { childList: true });

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
      children.disconnect();
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
