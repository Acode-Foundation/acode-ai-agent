import type { RefObject } from "preact";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";
import { loadSponsor, sponsorsConfigured } from "../suggestions/elo";
import { isFreeAcode, sponsorConsent, sponsorPreferencesChanged } from "../suggestions/preferences";
import { type SponsorBudget, SponsorSession } from "../suggestions/session";
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
  turns: readonly ChatTurn[],
  obscured: boolean,
  isTabActive: () => boolean,
  budget: SponsorBudget,
  composing = false,
) {
  const turn = turns.at(-1);
  const optInRef = useRef<HTMLElement>(null);
  const [, redraw] = useReducer((revision: number) => revision + 1, 0);
  const [hidden, setHidden] = useState(true);
  const [consent, setConsent] = useState(sponsorConsent);
  const card = budget.card(chatId);
  const offeredChat = budget.optInChatId;
  const budgetView = useRef({ chatId, card, offeredChat });
  budgetView.current = { chatId, card, offeredChat };
  const latestTurns = useRef(turns);
  latestTurns.current = turns;
  const host = useRef({ root, isTabActive });
  host.current = { root, isTabActive };

  const composingRef = useRef(composing);
  composingRef.current = composing;
  const obscuredRef = useRef(obscured);
  obscuredRef.current = obscured;
  const [session] = useState(() => {
    const visible = () =>
      !document.hidden &&
      host.current.isTabActive() &&
      !obscuredRef.current &&
      !composingRef.current &&
      Boolean(host.current.root.current?.getClientRects().length);
    return new SponsorSession({
      budget,
      consent: sponsorConsent,
      eligible: () => sponsorsConfigured() && isFreeAcode(),
      visible,
      load: (topics, signal) => {
        const conversation = host.current.root.current;
        const slot = conversation?.parentElement?.querySelector<HTMLElement>(".composer-dock");
        if (!conversation || !slot) return Promise.resolve(null);
        // Reserve the compact strip without consuming the whole conversation viewport.
        const maxHeight = Math.floor(conversation.clientHeight);
        const maxWidth = Math.floor(slot.getBoundingClientRect().width);
        if (maxHeight < 72 || maxWidth <= 0) return Promise.resolve(null);
        return loadSponsor(topics, signal, { maxHeight: 72, maxWidth }, visible);
      },
    });
  });
  useLayoutEffect(
    () =>
      budget.changes.subscribe(() => {
        if (document.hidden || !host.current.isTabActive()) return;
        const previous = budgetView.current;
        // Global clears and opt-in ownership still affect this chat; unrelated cards do not.
        if (
          budget.card(previous.chatId) !== previous.card ||
          budget.optInChatId !== previous.offeredChat
        )
          redraw(undefined);
      }),
    [budget],
  );
  const refresh = useCallback(
    (reconcile = false) => {
      const hidden =
        document.hidden ||
        !host.current.isTabActive() ||
        !host.current.root.current?.getClientRects().length ||
        !sponsorsConfigured() ||
        !isFreeAcode();
      setHidden(hidden);
      session.refresh();
      // Reconcile changes skipped while this tab was inactive, even if visibility stayed true.
      if (reconcile && !hidden) redraw(undefined);
    },
    [session],
  );
  useEffect(() => {
    const preferences = sponsorPreferencesChanged.subscribe((value) => {
      setConsent(value);
      refresh();
    });
    let frame = 0;
    const afterLayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => refresh(true));
    };
    const onVisibility = () => (document.hidden ? refresh() : afterLayout());
    const onSwitch = () => (host.current.isTabActive() ? afterLayout() : refresh());
    if (typeof editorManager !== "undefined") editorManager.on("switch-file", onSwitch);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("resume", afterLayout);
    window.addEventListener("focus", afterLayout);
    return () => {
      preferences();
      cancelAnimationFrame(frame);
      if (typeof editorManager !== "undefined") editorManager.off("switch-file", onSwitch);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("resume", afterLayout);
      window.removeEventListener("focus", afterLayout);
      session.dispose();
    };
  }, [session, refresh]);
  // The turn and its dimensions are available as soon as the DOM commits.
  useLayoutEffect(() => {
    session.update(chatId, running, turn, () =>
      latestTurns.current.slice(-5, -1).map((item) => item.user ?? ""),
    );
  }, [
    session,
    chatId,
    running,
    turn?.id,
    turn?.user,
    Boolean(turn?.answer),
    Boolean(turn?.error),
    turn?.stopped,
    turn?.streaming,
  ]);
  const waiting = running && turn?.streaming && !turn.answer && !turn.error && !turn.stopped;
  const cached = consent === "allowed" ? card : undefined;
  const offerCandidate = Boolean(
    chatId && (offeredChat ? offeredChat === chatId : waiting && turn.user) && consent === "ask",
  );
  const visible =
    Boolean(cached || offerCandidate) &&
    !obscured &&
    !hidden &&
    !document.hidden &&
    isTabActive() &&
    isFreeAcode() &&
    sponsorsConfigured();
  const showOptIn = useSponsorOptInAvailable(offerCandidate && visible);
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
  useLayoutEffect(() => {
    refresh();
  }, [refresh, root, isTabActive, obscured, composing]);
  return {
    showOptIn,
    optInRef,
    placement: visible && !composing && !turn?.stopped && !turn?.error ? cached : undefined,
  };
}
