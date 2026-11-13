import { Signal } from "../core/events";

export type SponsorConsent = "ask" | "allowed" | "declined";
const KEY = "acode.ai-agent.sponsors.v1";
export const sponsorPreferencesChanged = new Signal<SponsorConsent>();

export const sponsorIdentityCleared = new Signal<void>();

let storageBlocked = false;

export const SPONSOR_DISCLOSURE =
  "Elo receives broad task topics, device and network information, and reads advertising consent signals. It stores an anonymous identifier in local storage and a cookie. Ad partners can receive network information. Your messages, code, files, and account details stay out of ad requests. Sponsored links open an external site. If this version of Acode cannot supply the required device consent signals, suggestions stay off.";

export function canRequestSponsors(): boolean {
  return isFreeAcode() && sponsorConsent() === "allowed";
}

export function sponsorConsent(): SponsorConsent {
  try {
    if (storageBlocked) return "declined";
    const value = localStorage.getItem(KEY);
    return value === "allowed" || value === "declined" ? value : "ask";
  } catch {
    return "ask";
  }
}

export function setSponsorConsent(value: SponsorConsent): void {
  try {
    localStorage.setItem(KEY, value);
    storageBlocked = false;
  } catch {
    // Without durable consent, leave advertising disabled.
    storageBlocked = true;
    value = "declined";
  }
  if (value === "declined") clearSponsorIdentity();
  sponsorPreferencesChanged.emit(value);
}

export function clearSponsorIdentity(): void {
  for (const key of ["elo_visitor_id", "growl_visitor_id"]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Cookie access may still be available.
    }
  }
  for (const name of ["_elo_state", "_growl_state"]) {
    try {
      document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
    } catch {
      // The host may block cookies.
    }
  }
  // Invalidate live SDK sessions even when storage was empty or inaccessible.
  sponsorIdentityCleared.emit();
}

export function isFreeAcode(): boolean {
  try {
    return acode.require("config").HAS_PRO === false;
  } catch {
    return false;
  }
}
