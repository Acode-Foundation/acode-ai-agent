import { useEffect, useState } from "preact/hooks";
import { readSponsorConsent } from "../suggestions/consent";

/** Offer opt-in only when the device can supply consent. Never starts Elo. */
export function useSponsorOptInAvailable(check: boolean) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!check) {
      setAvailable(false);
      return;
    }
    let current: AbortController | undefined;
    let frame = 0;
    let recheck = false;
    const refresh = async () => {
      frame = 0;
      if (document.hidden) {
        current?.abort();
        current = undefined;
        recheck = false;
        setAvailable(false);
        return;
      }
      if (current) {
        recheck = true;
        return;
      }
      const request = new AbortController();
      current = request;
      try {
        const result = await readSponsorConsent(request.signal);
        if (!request.signal.aborted && (!recheck || result.status !== "allowed"))
          setAvailable(result.status === "allowed");
      } catch {
        if (!request.signal.aborted) setAvailable(false);
      } finally {
        if (current === request) {
          current = undefined;
          if (recheck && !request.signal.aborted) {
            recheck = false;
            void refresh();
          }
        }
      }
    };
    const onChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        void refresh();
      } else if (!frame) {
        frame = requestAnimationFrame(refresh);
      }
    };
    void refresh();
    document.addEventListener("visibilitychange", onChange);
    document.addEventListener("resume", onChange);
    window.addEventListener("focus", onChange);
    if (typeof editorManager !== "undefined") editorManager.on("switch-file", onChange);
    return () => {
      cancelAnimationFrame(frame);
      current?.abort();
      document.removeEventListener("visibilitychange", onChange);
      document.removeEventListener("resume", onChange);
      window.removeEventListener("focus", onChange);
      if (typeof editorManager !== "undefined") editorManager.off("switch-file", onChange);
    };
  }, [check]);
  return check && available;
}
