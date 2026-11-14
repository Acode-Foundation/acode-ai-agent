/**
 * Marks each `.md-table` scroller with `data-more-left` / `data-more-right`
 * while columns are hidden past that edge, so CSS can fade the edge as a cue.
 */
export function mountTableScroll(host: HTMLElement): () => void {
  const scrollers = [...host.querySelectorAll<HTMLElement>(".md-table")];
  if (!scrollers.length) return () => {};

  const update = (el: HTMLElement) => {
    const max = el.scrollWidth - el.clientWidth;
    const left = Math.abs(el.scrollLeft);
    el.toggleAttribute("data-more-left", left > 1);
    el.toggleAttribute("data-more-right", max - left > 1);
  };
  const onScroll = (event: Event) => update(event.currentTarget as HTMLElement);
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver((entries) => {
          for (const entry of entries) update(entry.target as HTMLElement);
        });

  for (const el of scrollers) {
    update(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    observer?.observe(el);
  }

  return () => {
    observer?.disconnect();
    for (const el of scrollers) el.removeEventListener("scroll", onScroll);
  };
}
