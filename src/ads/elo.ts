import { type AdCreative, type AdTap, EloSDK } from "@elo-ads/web-sdk/core";
import {
  hasSponsorConsentBridge,
  readSponsorConsent,
  withSponsorConsent,
  type ConsentSignals,
} from "./consent";
import {
  canRequestSponsors,
  sponsorIdentityCleared,
  sponsorPreferencesChanged,
} from "./preferences";

declare const ELO_PUBLISHER_ID: string;
declare const ELO_AD_UNIT_ID: string;
declare const ELO_IOS_AD_UNIT_ID: string;

export type Sponsor = { ad: AdCreative; sdk: SponsorSDK; consent: string };
const eloOrigin = "https://api.elo.ad";
const publisherId = typeof ELO_PUBLISHER_ID === "string" ? ELO_PUBLISHER_ID.trim() : "";
const androidUnit = typeof ELO_AD_UNIT_ID === "string" ? ELO_AD_UNIT_ID.trim() : "";
const iosUnit = typeof ELO_IOS_AD_UNIT_ID === "string" ? ELO_IOS_AD_UNIT_ID.trim() : "";

function unitId() {
  const platform = (globalThis as { cordova?: { platformId?: string } }).cordova?.platformId;
  const androidApi = (globalThis as { ANDROID_SDK_INT?: number }).ANDROID_SDK_INT;
  if (platform === "android" && !(Number(androidApi) >= 29)) return "";
  return platform === "ios" ? iosUnit : platform === "android" ? androidUnit : "";
}

export function sponsorsConfigured() {
  try {
    return Boolean(
      publisherId &&
      unitId() &&
      typeof globalThis.crypto?.getRandomValues === "function" &&
      hasSponsorConsentBridge(),
    );
  } catch {
    // A Cordova property getter can throw while the native bridge is unavailable.
    return false;
  }
}

// Older WebViews have secure random bytes but lack the UUID convenience method used by Elo.
function ensureRandomUUID() {
  if (!crypto.randomUUID) {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        return [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20),
        ].join("-");
      },
    });
  }
}

let session:
  | { consent: string; sdk: SponsorSDK; ready: Promise<SponsorSDK | null>; initialized: boolean }
  | undefined;
sponsorIdentityCleared.subscribe(() => {
  session = undefined;
});
sponsorPreferencesChanged.subscribe((consent) => {
  if (consent !== "allowed") session = undefined;
});

// UMP can change in a native dialog without a WebView focus or visibility event.
class SponsorSDK extends EloSDK {
  #views = new WeakMap<AdCreative, { signal: AbortSignal; onViewed?: () => void }>();

  constructor(private readonly consentKey: string) {
    // The pinned SDK accepts baseUrl at runtime. Use the same origin for validation.
    const config = { publisherId, adUnitId: unitId(), baseUrl: eloOrigin };
    super(config);
  }

  attachView(ad: AdCreative, signal: AbortSignal, onViewed?: () => void): boolean {
    if (session?.sdk !== this || signal.aborted) return false;
    this.#views.set(ad, { signal, onViewed });
    return true;
  }

  async canTrack(ad: AdCreative): Promise<boolean> {
    try {
      const signal = this.#views.get(ad)?.signal;
      const eligible = () =>
        !signal?.aborted && !document.hidden && canRequestSponsors() && session?.sdk === this;
      if (!signal || !eligible()) return false;
      const result = await readSponsorConsent(signal);
      return (
        eligible() &&
        result.status === "allowed" &&
        JSON.stringify(result.signals) === this.consentKey
      );
    } catch {
      return false;
    }
  }

  override async trackImpression(ad: AdCreative) {
    if (!(await this.canTrack(ad))) return false;
    // The SDK calls this after a continuous second at least 50% visible.
    // Start the local frequency cap even if the tracking request later fails.
    this.#views.get(ad)?.onViewed?.();
    return super.trackImpression(ad);
  }

  override async trackTap(_ad: AdCreative, _tap: AdTap) {
    // Elo 0.8.0 retries tap telemetry without a cancellation signal. Link opens
    // and the SDK's separate, consent-checked click notices still work.
    return false;
  }

  override async trackClick(ad: AdCreative) {
    if (await this.canTrack(ad)) super.trackClick(ad);
  }
}

function sdkSession(signals: ConsentSignals) {
  const consent = JSON.stringify(signals);
  if (session?.consent === consent) return session;
  ensureRandomUUID();
  const sdk = new SponsorSDK(consent);
  const current = {
    consent,
    sdk,
    initialized: false,
    ready: withSponsorConsent(signals, () => sdk.init())
      .then(({ status }) => (status === "ready" ? sdk : null))
      .catch(() => null),
  };
  session = current;
  void current.ready.then((ready) => {
    current.initialized = Boolean(ready);
    if (!ready && session === current) session = undefined;
  });
  return current;
}

export async function loadSponsor(
  topics: string[],
  signal: AbortSignal,
  dimensions: { maxHeight: number; maxWidth: number },
  visible: () => boolean = () => !document.hidden,
): Promise<Sponsor | null> {
  try {
    const eligible = () => !signal.aborted && !document.hidden && visible() && canRequestSponsors();
    if (!topics.length || !sponsorsConfigured() || !eligible()) return null;
    const initial = await readSponsorConsent(signal);
    if (initial.status !== "allowed" || !eligible()) return null;
    const current = sdkSession(initial.signals);
    // A ready SDK can use this request's fresh read immediately. When init
    // yields to native code, check again before handing topics to the SDK.
    if (!current.initialized) {
      if (!(await current.ready) || !stillEligible()) return null;
      const latest = await readSponsorConsent(signal);
      if (latest.status !== "allowed" || current.consent !== JSON.stringify(latest.signals))
        return null;
    }
    function stillEligible() {
      return session === current && eligible();
    }
    if (!stillEligible()) return null;
    const sdk = current.sdk;
    const { ad } = await sdk.fetchAds({
      ...dimensions,
      signal,
      messages: [{ role: "summary", content: topics[0] }],
      context: topics.map((description) => ({ type: "topic", description })),
    });
    if (!ad?.title || !safeAdUrl(ad.click_url) || !stillEligible()) return null;
    const trackingUrl = (url: string) =>
      safeAdUrl(url?.startsWith("/") ? `${eloOrigin}${url}` : url);
    if (
      ![ad.render_url, ad.impression_url].every((url) => {
        const safe = trackingUrl(url);
        return safe && new URL(safe).origin === eloOrigin;
      })
    )
      return null;
    // Partner notices can use third-party HTTPS origins.
    const trackers = ad.trackers?.filter((tracker) => tracker && trackingUrl(tracker.url));
    // Use the SDK's full-card link. Acode supplies the dismiss control.
    const presentation = {
      ...ad.presentation,
      format: ad.presentation?.format ?? "card",
      cta_enabled: false,
    };
    return { ad: { ...ad, presentation, trackers }, sdk, consent: current.consent };
  } catch {
    return null;
  }
}

export function safeAdUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
