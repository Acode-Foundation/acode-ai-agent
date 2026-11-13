import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { loadSponsor, sponsorsConfigured } from "../ads/elo";
import { isFreeAcode, sponsorConsent, sponsorPreferencesChanged } from "../ads/preferences";
import { type SponsorBudget, SponsorSession, type SponsorPlacement } from "../ads/session";
import { useSponsorOptInAvailable } from "./useSponsorOptInAvailable";
import type { ChatTurn } from "./transcript";

// The dock is clipped by the editor shell and can also extend outside the visible WebView.
function halfVisible(card: HTMLElement, shell: Element): boolean {
  const rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const clip = shell.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? window.innerWidth);
  const bottom = top + (viewport?.height ?? window.innerHeight);
  const width = Math.min(rect.right, clip.right, right) - Math.max(rect.left, clip.left, left);
  const height = Math.min(rect.bottom, clip.bottom, bottom) - Math.max(rect.top, clip.top, top);
  return width > 0 && height > 0 && width * height >= rect.width * rect.height * 0.5;
}

export function useSponsor(
  root: RefObject<HTMLElement>,
  chatId: string | undefined,
  running: boolean,
  turn: ChatTurn | undefined,
  obscured: boolean,
  isTabActive: () => boolean,
  budget: SponsorBudget,
) {
  const optInRef = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<SponsorPlacement>();
  const [hidden, setHidden] = useState(true);
  const [consent, setConsent] = useState(sponsorConsent);

  const obscuredRef = useRef(obscured);
  obscuredRef.current = obscured;
  const [session] = useState(() => {
    const visible = () =>
      !document.hidden &&
      isTabActive() &&
      !obscuredRef.current &&
      Boolean(root.current?.getClientRects().length);
    return new SponsorSession({
      budget,
      consent: sponsorConsent,
      eligible: () => sponsorsConfigured() && isFreeAcode(),
      visible,
      load: (topics, signal, waiting) => {
        const conversation = root.current;
        const turn = conversation?.querySelector<HTMLElement>(".turn:last-of-type");
        if (!conversation || !turn) return Promise.resolve(null);
        // The turn scrolls. Use the viewport height less the margin above the card.
        const maxHeight = Math.floor(conversation.clientHeight - 14);
        const maxWidth = Math.floor(turn.getBoundingClientRect().width);
        if (maxHeight < 72 || maxWidth <= 0) return Promise.resolve(null);
        return loadSponsor(
          topics,
          signal,
          { maxHeight: waiting ? 72 : maxHeight, maxWidth },
          visible,
        );
      },
    });
  });
  useEffect(() => {
    const unsubscribe = session.changes.subscribe(setPlacement);
    const refresh = () => {
      setHidden(
        document.hidden ||
          !isTabActive() ||
          !root.current?.getClientRects().length ||
          !sponsorsConfigured() ||
          !isFreeAcode(),
      );
      session.refresh();
    };
    const preferences = sponsorPreferencesChanged.subscribe((value) => {
      setConsent(value);
      refresh();
    });
    let frame = 0;
    const afterLayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    const onVisibility = () => (document.hidden ? refresh() : afterLayout());
    const onSwitch = () => (isTabActive() ? afterLayout() : refresh());
    refresh();
    if (typeof editorManager !== "undefined") editorManager.on("switch-file", onSwitch);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("resume", afterLayout);
    window.addEventListener("focus", afterLayout);
    return () => {
      unsubscribe();
      preferences();
      cancelAnimationFrame(frame);
      if (typeof editorManager !== "undefined") editorManager.off("switch-file", onSwitch);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("resume", afterLayout);
      window.removeEventListener("focus", afterLayout);
      session.dispose();
    };
  }, [session, root, isTabActive]);
  // Invalidate the old turn at commit, before a queued waiting timer can fire.
  useLayoutEffect(() => {
    session.update(chatId, running, turn);
  }, [
    session,
    chatId,
    running,
    turn?.id,
    Boolean(turn?.answer),
    Boolean(turn?.error),
    turn?.stopped,
    turn?.streaming,
  ]);
  const waiting = running && turn?.streaming && !turn.answer && !turn.error && !turn.stopped;
  const offeredChat = budget.optInChatId;
  const showOptIn = useSponsorOptInAvailable(
    Boolean(
      chatId &&
      (offeredChat ? offeredChat === chatId : waiting && turn.user) &&
      consent === "ask" &&
      !obscured &&
      !hidden &&
      !document.hidden &&
      isTabActive(),
    ),
  );
  useLayoutEffect(() => {
    if (offeredChat || !chatId || !showOptIn) return;
    const card = optInRef.current;
    const shell = root.current?.parentElement;
    if (!card || !shell) return;
    const claim = () => {
      if (card.isConnected && !document.hidden && isTabActive() && !obscuredRef.current)
        budget.optInChatId ??= chatId;
    };
    const checkBounds = () => {
      if (halfVisible(card, shell)) claim();
    };
    // A fast reply can remove the card before the first observer callback.
    checkBounds();
    if (budget.optInChatId) return;
    if (typeof IntersectionObserver !== "function") {
      window.addEventListener("resize", checkBounds);
      window.addEventListener("scroll", checkBounds, true);
      window.visualViewport?.addEventListener("resize", checkBounds);
      return () => {
        window.removeEventListener("resize", checkBounds);
        window.removeEventListener("scroll", checkBounds, true);
        window.visualViewport?.removeEventListener("resize", checkBounds);
      };
    }
    let observing = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !observing ||
          !entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)
        )
          return;
        claim();
        if (budget.optInChatId) observer.disconnect();
      },
      { threshold: 0.5 },
    );
    observer.observe(card);
    return () => {
      observing = false;
      observer.disconnect();
    };
  }, [offeredChat, chatId, showOptIn, isTabActive, budget, root]);
  const waitingId = consent === "allowed" && waiting ? turn.id : undefined;
  const waitingPrompt = waiting ? turn.user : undefined;
  useEffect(() => {
    if (!chatId || !waitingId || !waitingPrompt || obscured || hidden) return;
    const timer = setTimeout(
      () => session.showWhileWaiting(chatId, waitingId, waitingPrompt),
      3000,
    );
    return () => clearTimeout(timer);
  }, [session, chatId, waitingId, waitingPrompt, obscured, hidden]);
  useLayoutEffect(() => {
    session.refresh();
  }, [session, obscured, hidden]);
  return {
    showOptIn,
    optInRef,
    placement: placement && !obscured && !hidden && isFreeAcode() ? placement : undefined,
    session,
  };
}
