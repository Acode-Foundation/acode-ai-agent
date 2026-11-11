import { type AdCreative, EloSDK } from "@elo-ads/web-sdk/core";
import { canRequestSponsors } from "./preferences";

declare const ELO_PUBLISHER_ID: string;
declare const ELO_AD_UNIT_ID: string;
declare const ELO_IOS_AD_UNIT_ID: string;

export type Sponsor = { ad: AdCreative; sdk: EloSDK };
const publisherId = typeof ELO_PUBLISHER_ID === "string" ? ELO_PUBLISHER_ID.trim() : "";
const androidUnit = typeof ELO_AD_UNIT_ID === "string" ? ELO_AD_UNIT_ID.trim() : "";
const iosUnit = typeof ELO_IOS_AD_UNIT_ID === "string" ? ELO_IOS_AD_UNIT_ID.trim() : "";

function unitId() {
  const platform = (globalThis as { cordova?: { platformId?: string } }).cordova?.platformId;
  return platform === "ios" ? iosUnit : platform === "android" ? androidUnit : "";
}

export function sponsorsConfigured() {
  return Boolean(publisherId && unitId() && globalThis.crypto?.getRandomValues);
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

export async function loadSponsor(context: string, signal: AbortSignal): Promise<Sponsor | null> {
  try {
    if (!sponsorsConfigured() || document.hidden || signal.aborted || !canRequestSponsors())
      return null;
    ensureRandomUUID();
    const sdk = new EloSDK({ publisherId, adUnitId: unitId() });
    if ((await sdk.init()).status !== "ready") return null;
    if (!(await foreground(signal)) || !canRequestSponsors()) return null;
    const { ad } = await sdk.fetchAds({
      signal,
      messages: [{ role: "summary", content: context }],
    });
    if (!ad?.title || !safeAdUrl(ad.click_url) || signal.aborted || !canRequestSponsors())
      return null;
    return { ad, sdk };
  } catch {
    return null;
  }
}

// Preserve an already claimed opportunity if the app backgrounds during SDK initialization.
function foreground(signal: AbortSignal): Promise<boolean> | boolean {
  if (signal.aborted || !document.hidden) return !signal.aborted;
  return new Promise((resolve) => {
    const resume = () => {
      if (!signal.aborted && document.hidden) return;
      document.removeEventListener("visibilitychange", resume);
      signal.removeEventListener("abort", resume);
      resolve(!signal.aborted);
    };
    document.addEventListener("visibilitychange", resume);
    signal.addEventListener("abort", resume);
  });
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
