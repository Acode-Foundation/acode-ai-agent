import { mountEloAd } from "@elo-ads/web-sdk/core";
import { Heart, Megaphone, X } from "lucide-preact";
import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { readSponsorConsent } from "../suggestions/consent";
import { safeAdUrl } from "../suggestions/elo";
import {
  canRequestSponsors,
  setSponsorConsent,
  sponsorPreferencesChanged,
  sponsorIdentityCleared,
  SPONSOR_DISCLOSURE,
} from "../suggestions/preferences";
import type { SponsorPlacement, SponsorBudget } from "../suggestions/session";
import { openCustomTab } from "../platform/authTab";
import { showToast } from "../platform/toast";

// Retry bridge or malformed reads before mounting the SDK view. An existing
// view must stop immediately when consent cannot be verified. Deadline timeouts
// are not retried because another native round trip will usually time out too.
const CONSENT_RETRIES = 2;
const CONSENT_RETRY_MS = 500;

function retriableConsent(result: Awaited<ReturnType<typeof readSponsorConsent>>): boolean {
  return (
    result.status === "unavailable" && result.reason !== "timeout" && result.reason !== "aborted"
  );
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export function SponsoredCard({
  placement,
  budget,
}: {
  placement: SponsorPlacement;
  budget: SponsorBudget;
}) {
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const sponsor = placement.sponsor;
  const ad = sponsor.ad;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !safeAdUrl(sponsor.ad.click_url)) return;
    const ad = sponsor.ad;
    // View signals are keyed by creative object; each mounted view owns its signal.
    const creative = { ...ad };
    if (creative.image_url && !safeAdUrl(creative.image_url)) delete creative.image_url;
    const frame = element.closest<HTMLElement>(".sponsor");
    if (!frame) return;
    let checking = false;
    let view: AbortController | undefined;
    let focusFrame = 0;
    let opening = false;
    let openHint = 0;
    let unmount: (() => void) | undefined;
    let stopImage: (() => void) | undefined;
    const syncThumbnail = () =>
      frame.classList.toggle("sponsor-no-image", !element.querySelector(".elo-ad-image"));
    const stop = () => {
      cancelAnimationFrame(focusFrame);
      clearTimeout(openHint);
      opening = false;
      checking = false;
      view?.abort();
      view = undefined;
      frame.hidden = true;
      stopImage?.();
      stopImage = undefined;
      try {
        unmount?.();
      } catch {
        // A failed SDK cleanup must not interrupt the chat.
      } finally {
        unmount = undefined;
        element.replaceChildren();
        label.current?.replaceChildren();
      }
    };
    const refresh = async () => {
      cancelAnimationFrame(focusFrame);
      if (document.hidden || !canRequestSponsors()) {
        stop();
        return;
      }
      if (checking) return;
      checking = true;
      view ??= new AbortController();
      const current = view;
      let result: Awaited<ReturnType<typeof readSponsorConsent>>;
      try {
        result = await readSponsorConsent(current.signal);
        for (
          let attempt = 0;
          !unmount && attempt < CONSENT_RETRIES && retriableConsent(result);
          attempt++
        ) {
          if (document.hidden || !(await waitForRetry(CONSENT_RETRY_MS, current.signal))) break;
          // The view can hide during the wait; do not start another native read.
          if (document.hidden || !canRequestSponsors()) break;
          result = await readSponsorConsent(current.signal);
        }
      } catch {
        if (view === current) stop();
        return;
      } finally {
        // A paused view can settle after its replacement has started checking.
        if (view === current) checking = false;
      }
      if (current.signal.aborted) return;
      if (document.hidden || result.status === "unavailable") {
        stop();
        return;
      }
      if (
        result.status !== "allowed" ||
        JSON.stringify(result.signals) !== sponsor.consent ||
        !canRequestSponsors() ||
        !sponsor.sdk.attachView(creative, current.signal, () => budget.viewed(placement))
      ) {
        stop();
        budget.dismiss(placement);
        return;
      }
      if (unmount) return;
      if (typeof IntersectionObserver !== "function") {
        budget.dismiss(placement);
        return;
      }
      try {
        frame.hidden = false;
        unmount = mountEloAd(element, sponsor.sdk, creative, {
          sponsoredLabel: "Sponsored · Elo",
          openUrl: async (value) => {
            const url = safeAdUrl(value);
            if (!url || opening || current.signal.aborted) return;
            opening = true;
            let deadline = 0;
            const hint = window.setTimeout(() => {
              if (!current.signal.aborted) showToast("Opening sponsored link…");
            }, 250);
            openHint = hint;
            try {
              // Bound navigation latency without reusing stale consent. On timeout,
              // stopping the view also cancels pending tracking and SDK tap retries.
              const allowed = await Promise.race([
                sponsor.sdk.canTrack(creative).catch(() => false),
                new Promise<false>((resolve) => {
                  deadline = window.setTimeout(() => resolve(false), 1000);
                }),
              ]);
              clearTimeout(hint);
              clearTimeout(deadline);
              if (current.signal.aborted) return;
              if (!allowed) {
                showToast("Could not verify ad consent. Please try again.");
                stop();
                void refresh();
                return;
              }
              try {
                await openCustomTab(url);
              } catch {
                if (!current.signal.aborted) showToast("Could not open this sponsored link.");
                return;
              }
              // The native callback can arrive after a pause or even a chat switch.
              budget.dismiss(placement, true);
            } finally {
              clearTimeout(deadline);
              clearTimeout(hint);
              // A previous attempt must not clear a replacement view's feedback.
              if (view === current) {
                opening = false;
              }
            }
          },
        });
        const image = element.querySelector<HTMLImageElement>(".elo-ad-image");
        const parent = image?.parentElement;
        if (image && parent) {
          const next = image.nextSibling;
          const source = image.src;
          let retry = 0;
          let retried = false;
          const active = () => !current.signal.aborted && !document.hidden && canRequestSponsors();
          const loaded = () => {
            if (!active()) return;
            // Elo removes failed images. Restore this same node only once it loads,
            // without remounting the ad or duplicating render/impression tracking.
            if (!parent.contains(image))
              parent.insertBefore(image, next?.parentNode === parent ? next : null);
            syncThumbnail();
          };
          const failed = () => {
            syncThumbnail();
            if (retried || !active()) return;
            retried = true;
            retry = window.setTimeout(() => {
              void sponsor.sdk
                .canTrack(creative)
                .then((allowed) => {
                  if (allowed && active()) image.src = source;
                })
                .catch(() => {});
            }, 1000);
          };
          image.addEventListener("load", loaded);
          image.addEventListener("error", failed);
          stopImage = () => {
            clearTimeout(retry);
            image.removeEventListener("load", loaded);
            image.removeEventListener("error", failed);
            // Cancel a detached retry where possible when the view loses consent.
            if (!parent.contains(image)) image.removeAttribute("src");
          };
        }
        syncThumbnail();
        if (creative.presentation?.format === "strip") {
          // Read the SDK's clamped inset rather than duplicating its normalization.
          const inset = parseFloat(element.querySelector("a")?.style.margin ?? "") || 0;
          frame.style.setProperty("--sponsor-inset", `${inset}px`);
          const title = element.querySelector(".elo-ad-title");
          const disclosure = title?.querySelector(".elo-ad-sponsored");
          if (title && disclosure) {
            // Keep Elo's disclosure visible outside the clickable card.
            label.current?.replaceChildren(disclosure);
            title.textContent = creative.title;
          }
        }
      } catch {
        stop();
        budget.dismiss(placement);
      }
    };
    const onFocus = () => {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => void refresh());
    };
    const unsubscribe = sponsorPreferencesChanged.subscribe((consent) => {
      if (consent !== "allowed") stop();
    });
    const identityCleared = sponsorIdentityCleared.subscribe(() => {
      if (opening && !document.hidden)
        showToast("This sponsored link is unavailable with your current privacy settings.");
      stop();
      budget.dismiss(placement);
    });
    document.addEventListener("visibilitychange", refresh);
    document.addEventListener("pause", stop);
    document.addEventListener("resume", refresh);
    window.addEventListener("focus", onFocus);
    frame.hidden = true;
    void refresh();
    return () => {
      unsubscribe();
      identityCleared();
      document.removeEventListener("visibilitychange", refresh);
      document.removeEventListener("pause", stop);
      document.removeEventListener("resume", refresh);
      window.removeEventListener("focus", onFocus);
      stop();
      frame.hidden = false;
    };
  }, [placement, sponsor, budget]);

  if (!safeAdUrl(ad.click_url)) return null;
  return (
    <aside class="sponsor" aria-label="Sponsored suggestion">
      <div class="sponsor-label" ref={label} />
      <div class="sponsor-body">
        {ad.presentation?.format === "strip" && (
          <span class="sponsor-thumbnail" aria-hidden="true">
            <Megaphone size={18} />
          </span>
        )}
        <div class="sponsor-card" ref={root} />
        <button
          type="button"
          class="icon-button sponsor-dismiss"
          aria-label="Dismiss sponsored suggestion"
          onClick={() => budget.dismiss(placement, true)}
        >
          <X size={14} />
        </button>
      </div>
    </aside>
  );
}

function openSponsorPrivacy() {
  const policyUrl = "https://acode.app/policy";
  const dialogBox = acode.require("dialogBox");
  dialogBox(
    "Sponsored suggestions privacy",
    `<p>${SPONSOR_DISCLOSURE}</p><p>You can change this in AI settings.</p><p><a href="${policyUrl}">Acode privacy policy</a></p>`,
    "Done",
    "",
  ).onclick((event) => {
    if (!(event.target instanceof HTMLAnchorElement) || event.target.href !== policyUrl) return;
    event.preventDefault();
    event.stopPropagation();
    void openCustomTab(policyUrl).catch(() => showToast("Could not open privacy information."));
  });
}

export function SponsorOptIn({ cardRef }: { cardRef?: RefObject<HTMLElement> }) {
  return (
    <aside ref={cardRef} class="sponsor-consent" aria-label="Sponsored suggestions">
      <header>
        <strong>
          <Heart size={15} aria-hidden="true" />
          Support free Acode
        </strong>
        <button
          type="button"
          class="sponsor-privacy"
          aria-haspopup="dialog"
          onClick={openSponsorPrivacy}
        >
          Privacy
        </button>
      </header>
      <p>
        Elo uses broad coding topics, device info, and an anonymous ID in a cookie and local storage
        to show suggestions. It also measures taps on sponsored cards.
      </p>
      <div class="approval-actions sponsor-choices">
        <button type="button" onClick={() => setSponsorConsent("declined")}>
          No thanks
        </button>
        <button
          type="button"
          class="primary sponsor-allow"
          onClick={() => setSponsorConsent("allowed")}
        >
          Allow Suggestions
        </button>
      </div>
    </aside>
  );
}
