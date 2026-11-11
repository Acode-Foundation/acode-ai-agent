import { Signal } from "../core/events";

export type SponsorConsent = "ask" | "allowed" | "declined";
const KEY = "acode.ai-agent.sponsors.v1";
export const sponsorPreferencesChanged = new Signal<SponsorConsent>();

let storageBlocked = false;

export const SPONSOR_DISCLOSURE =
  "Elo receives a broad task category, device and network information, and reads advertising consent signals. It stores an anonymous identifier in local storage and a cookie. Ad partners can receive network information. Your messages, code, files, and account details stay out of ad requests. Sponsored links open an external site.";

export function canRequestSponsors(): boolean {
  if (!isFreeAcode() || sponsorConsent() !== "allowed") return false;
  try {
    // Check before SDK initialization, which otherwise persists an ID and pings Elo first.
    const applies = localStorage.getItem("IABTCF_gdprApplies")?.trim();
    if (applies === undefined || applies === "0") return true;
    return applies === "1" && Boolean(localStorage.getItem("IABTCF_TCString")?.trim());
  } catch {
    return false;
  }
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
  if (value === "declined") {
    try {
      for (const key of ["elo_visitor_id", "growl_visitor_id"]) localStorage.removeItem(key);
      for (const name of ["_elo_state", "_growl_state"])
        document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
    } catch {
      // Storage can be disabled by the host.
    }
  }
  sponsorPreferencesChanged.emit(value);
}

export function isFreeAcode(): boolean {
  try {
    return acode.require("config").HAS_PRO === false;
  } catch {
    return false;
  }
}
