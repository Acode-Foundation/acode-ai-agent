import { mountEloAd } from "@elo-ads/web-sdk/core";
import { Heart, Megaphone, X } from "lucide-preact";
import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { readSponsorConsent } from "../ads/consent";
import { safeAdUrl } from "../ads/elo";
import {
  canRequestSponsors,
  setSponsorConsent,
  sponsorPreferencesChanged,
  sponsorIdentityCleared,
  SPONSOR_DISCLOSURE,
} from "../ads/preferences";
import type { SponsorPlacement, SponsorBudget } from "../ads/session";
import { openCustomTab } from "../platform/authTab";
import { showToast } from "../platform/toast";

export function SponsoredCard({
  placement,
  budget,
}: {
  placement: SponsorPlacement;
  budget: SponsorBudget;
}) {
  const root = useRef<HTMLDivElement>(null);
  const sponsor = placement.sponsor;
  const ad = sponsor.ad;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !safeAdUrl(sponsor.ad.click_url)) return;
    const ad = sponsor.ad;
    // View signals are keyed by creative object; each mounted view owns its signal.
    const creative = { ...ad };
    if (creative.image_url && !safeAdUrl(creative.image_url)) delete creative.image_url;
    const frame = element.parentElement!;
    let checking = false;
    let view: AbortController | undefined;
    let focusFrame = 0;
    let unmount: (() => void) | undefined;
    let image: HTMLImageElement | null = null;
    const syncThumbnail = () =>
      frame.classList.toggle("sponsor-no-image", !element.querySelector(".elo-ad-image"));
    const stop = () => {
      cancelAnimationFrame(focusFrame);
      checking = false;
      view?.abort();
      view = undefined;
      frame.hidden = true;
      image?.removeEventListener("error", syncThumbnail);
      image = null;
      try {
        unmount?.();
      } catch {
        // A failed SDK cleanup must not interrupt the chat.
      } finally {
        unmount = undefined;
        element.replaceChildren();
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
      const current = (view ??= new AbortController());
      let result;
      try {
        result = await readSponsorConsent(current.signal);
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
            if (!url) return;
            const allowed = await sponsor.sdk.canTrack(creative);
            if (current.signal.aborted) return;
            if (!allowed) {
              // Elo already counted this as an open attempt. Reset the view before retrying.
              stop();
              void refresh();
              return;
            }
            try {
              await openCustomTab(url);
            } catch {
              showToast("Could not open this sponsored link.");
              return;
            }
            // The native callback can arrive after a pause or even a chat switch.
            budget.dismiss(placement, true);
          },
        });
        image = element.querySelector<HTMLImageElement>(".elo-ad-image");
        // Elo removes a failed image before this listener runs.
        image?.addEventListener("error", syncThumbnail);
        syncThumbnail();
        if (creative.presentation?.format === "strip") {
          // Read the SDK's clamped inset rather than duplicating its normalization.
          const inset = parseFloat(element.querySelector("a")?.style.margin ?? "") || 0;
          frame.style.setProperty("--sponsor-inset", `${inset}px`);
          const title = element.querySelector(".elo-ad-title");
          const disclosure = title?.querySelector(".elo-ad-sponsored");
          if (title && disclosure) {
            // Keep the SDK disclosure and tracking selector, but place it below the copy.
            title.parentElement?.append(disclosure);
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
        <X size={16} />
      </button>
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
        Elo uses broad coding topics, device info, and an anonymous ID stored in a cookie and local
        storage to show sponsored suggestions.
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
