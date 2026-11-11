import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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
) {
  const [placement, setPlacement] = useState<SponsorPlacement>();
  const [hidden, setHidden] = useState(document.hidden);
  const obscuredRef = useRef(obscured);
  obscuredRef.current = obscured;
  const [session] = useState(
    () =>
      new SponsorSession({
        budget,
        consent: sponsorConsent,
        eligible: () => sponsorsConfigured() && isFreeAcode(),
        visible: () =>
          !document.hidden &&
          !obscuredRef.current &&
          Boolean(root.current?.getClientRects().length),
        load: loadSponsor,
      }),
  );
  useEffect(() => {
    const unsubscribe = session.changes.subscribe(setPlacement);
    const preferences = sponsorPreferencesChanged.subscribe(() => session.refresh());
    const refresh = () => {
      setHidden(document.hidden);
      session.refresh();
    };
    document.addEventListener("visibilitychange", refresh);
    document.addEventListener("resume", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe();
      preferences();
      document.removeEventListener("visibilitychange", refresh);
      document.removeEventListener("resume", refresh);
      window.removeEventListener("focus", refresh);
      session.dispose();
    };
  }, [session]);
  useEffect(() => {
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
  useEffect(() => {
    session.refresh();
  }, [session, obscured, hidden]);
  return {
    placement: placement && !obscured && !hidden && isFreeAcode() ? placement : undefined,
    session,
  };
}
