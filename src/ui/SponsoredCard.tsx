import type { AdTapRegion } from "@elo-ads/web-sdk/core";
import { ArrowRight, ChevronRight, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { safeAdUrl } from "../ads/elo";
import { canRequestSponsors, setSponsorConsent, SPONSOR_DISCLOSURE } from "../ads/preferences";
import type { SponsorPlacement, SponsorSession } from "../ads/session";
import { observeSponsor } from "../ads/viewability";
import { openCustomTab } from "../platform/authTab";
import { showToast } from "../platform/toast";

export function SponsoredCard({
  placement,
  session,
}: {
  placement: SponsorPlacement;
  session: SponsorSession;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const opening = useRef(false);
  const lastClick = useRef(-Infinity);
  const sponsor = placement.sponsor;
  const ad = sponsor?.ad;
  useEffect(() => {
    if (!sponsor || !safeAdUrl(sponsor.ad.click_url) || !root.current) return;
    return observeSponsor(root.current, sponsor, canRequestSponsors);
  }, [sponsor]);
  useEffect(() => setImageFailed(false), [ad]);

  if (!ad || !sponsor)
    return (
      <aside class="sponsor-consent" aria-label="Sponsored suggestions">
        <b>Support free Acode</b>
        <p>Allow occasional sponsored suggestions after an answer?</p>
        <p class="sponsor-disclosure">{SPONSOR_DISCLOSURE}</p>
        <div class="sponsor-choices">
          <button
            type="button"
            class="text-button"
            onClick={() => {
              setSponsorConsent("declined");
              session.clear();
            }}
          >
            No thanks
          </button>
          <button
            type="button"
            class="text-button"
            onClick={() =>
              void openCustomTab("https://acode.app/policy").catch(() =>
                showToast("Could not open privacy information."),
              )
            }
          >
            Acode privacy
          </button>
          <button
            type="button"
            class="sponsor-allow"
            onClick={() => {
              setSponsorConsent("allowed");
              session.allow();
            }}
          >
            Allow suggestions
          </button>
        </div>
      </aside>
    );

  const url = safeAdUrl(ad.click_url);
  if (!url) return null;
  const image = !imageFailed && safeAdUrl(ad.image_url);
  const cta = ad.presentation?.cta_enabled !== false && ad.cta_text?.trim();
  const ctaOnly = Boolean(
    cta &&
    (ad.presentation?.tap_surface ?? (ad.presentation?.format === "strip" ? "cta" : "full")) ===
      "cta",
  );
  const strip = ad.presentation?.format === "strip";
  const padding = strip ? 14 : 12;
  const inset = ctaOnly
    ? 0
    : Math.min(padding, Math.max(0, Math.floor(ad.presentation?.tap_inset ?? 0)));
  const variant = ad.presentation?.cta_variant ?? "control";
  const link = {
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer" as const,
  };
  const reportTap = async (event: MouseEvent) => {
    if (event.type === "auxclick" && event.button !== 1) return;
    event.preventDefault();
    if (document.hidden || !canRequestSponsors()) return;
    const target = event.target as Element;
    const bounds = root.current!.getBoundingClientRect();
    const region = target.closest<HTMLElement>("[data-ad-region]")?.dataset.adRegion ?? "chrome";
    const tap = {
      region: region as AdTapRegion,
      x:
        event.detail && bounds.width
          ? Math.min(1, Math.max(0, (event.clientX - bounds.x) / bounds.width))
          : 0.5,
      y:
        event.detail && bounds.height
          ? Math.min(1, Math.max(0, (event.clientY - bounds.y) / bounds.height))
          : 0.5,
      width: bounds.width,
      height: bounds.height,
    };
    let opened = false;
    if (target.closest("a") && !opening.current && Date.now() - lastClick.current >= 1000) {
      opening.current = true;
      lastClick.current = Date.now();
      try {
        await openCustomTab(url);
        opened = true;
      } catch {
        showToast("Could not open this sponsored link.");
      } finally {
        opening.current = false;
      }
    }
    if (canRequestSponsors()) void sponsor.sdk.trackTap(ad, { ...tap, opened }).catch(() => {});
  };
  const Cta = ctaOnly ? "a" : "span";
  const content = (
    <>
      <div class="sponsor-copy">
        {image && (
          <img
            src={image}
            alt=""
            width="36"
            height="36"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            data-ad-region="thumbnail"
          />
        )}
        <div>
          <b data-ad-region="headline">{ad.title}</b>
          {ad.description && <p data-ad-region="description">{ad.description}</p>}
        </div>
      </div>
      {cta ? (
        <Cta {...(ctaOnly ? link : {})} class="sponsor-cta" data-ad-region="cta">
          {cta}
          {variant !== "control" && <ArrowRight size={14} />}
        </Cta>
      ) : (
        <ChevronRight size={18} aria-hidden="true" data-ad-region="chevron" />
      )}
    </>
  );
  return (
    <aside class="sponsor" aria-label="Sponsored suggestion">
      <div class="sponsor-label">
        <span>Sponsored · Elo</span>
        <button
          type="button"
          class="icon-button"
          aria-label="Dismiss sponsored suggestion"
          onClick={() => session.clear()}
        >
          <X size={14} />
        </button>
      </div>
      <div
        class={`sponsor-card${strip ? " strip" : ""}`}
        ref={root}
        data-variant={variant}
        onClick={reportTap}
        onAuxClick={reportTap}
      >
        {ctaOnly ? (
          <div class="sponsor-body">{content}</div>
        ) : (
          <a {...link} class="sponsor-body" style={{ margin: inset, padding: padding - inset }}>
            {content}
          </a>
        )}
      </div>
    </aside>
  );
}
