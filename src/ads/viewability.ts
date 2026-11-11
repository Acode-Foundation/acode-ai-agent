import type { Sponsor } from "./elo";

export function observeSponsor(
  element: HTMLElement,
  sponsor: Sponsor,
  eligible: () => boolean,
): () => void {
  let visible = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    element.removeAttribute("data-viewable");
    clearTimeout(timer);
    timer = undefined;
  };
  const check = () => {
    if (disposed || document.hidden || !visible || !eligible()) {
      cancel();
      return;
    }
    if (timer !== undefined || element.hasAttribute("data-viewable")) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && !document.hidden && visible && eligible()) {
        element.setAttribute("data-viewable", "");
        if (!sponsor.sdk.hasTrackedImpression(sponsor.ad))
          void sponsor.sdk.trackImpression(sponsor.ad).catch(() => {});
      }
    }, 1000);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !document.hidden && eligible())
          void sponsor.sdk.trackRender(sponsor.ad).catch(() => {});
        visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        check();
      }
    },
    { threshold: [0, 0.5] },
  );
  observer.observe(element);
  document.addEventListener("visibilitychange", check);
  return () => {
    disposed = true;
    cancel();
    observer.disconnect();
    document.removeEventListener("visibilitychange", check);
  };
}
