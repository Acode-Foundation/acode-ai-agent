import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { loadSponsor, sponsorsConfigured } from "../ads/elo";
import { isFreeAcode, sponsorConsent, sponsorPreferencesChanged } from "../ads/preferences";
import { SponsorBudget, SponsorSession, type SponsorPlacement } from "../ads/session";
import type { ChatTurn } from "./transcript";

// Shared across editor tabs: opening another chat must not reset the frequency cap.
const budget = new SponsorBudget();

export function useSponsor(
  root: RefObject<HTMLElement>,
  chatId: string | undefined,
  running: boolean,
  turn: ChatTurn | undefined,
  obscured: boolean,
  isTabActive: () => boolean,
) {
  const [placement, setPlacement] = useState<SponsorPlacement>();
  const [hidden, setHidden] = useState(document.hidden);
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
  const waiting =
    consent === "allowed" &&
    running &&
    turn?.streaming &&
    !turn.answer &&
    !turn.error &&
    !turn.stopped;
  const waitingId = waiting ? turn.id : undefined;
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
    placement: placement && !obscured && !hidden && isFreeAcode() ? placement : undefined,
    session,
  };
}
