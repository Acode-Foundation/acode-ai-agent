import { useEffect, useState } from "preact/hooks";
import { sponsorsConfigured } from "../ads/elo";
import {
  SPONSOR_DISCLOSURE,
  isFreeAcode,
  setSponsorConsent,
  sponsorConsent,
  sponsorPreferencesChanged,
} from "../ads/preferences";

export function SponsorSettings() {
  const [consent, setConsent] = useState(sponsorConsent);
  useEffect(() => sponsorPreferencesChanged.subscribe(setConsent), []);
  if (!sponsorsConfigured() || !isFreeAcode()) return null;
  return (
    <div class="sponsor-settings">
      <label class="toggle">
        <span>Sponsored suggestions</span>
        <input
          type="checkbox"
          checked={consent === "allowed"}
          onChange={(event) =>
            setSponsorConsent(event.currentTarget.checked ? "allowed" : "declined")
          }
        />
      </label>
      <p class="sponsor-disclosure">{SPONSOR_DISCLOSURE}</p>
    </div>
  );
}
