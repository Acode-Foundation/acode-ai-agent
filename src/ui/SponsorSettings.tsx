import { useEffect, useState } from "preact/hooks";
import { sponsorsConfigured } from "../suggestions/elo";
import {
  SPONSOR_DISCLOSURE,
  isFreeAcode,
  setSponsorConsent,
  sponsorConsent,
  sponsorPreferencesChanged,
} from "../suggestions/preferences";
import { useSponsorOptInAvailable } from "./useSponsorOptInAvailable";

export function SponsorSettings() {
  const [consent, setConsent] = useState(sponsorConsent);
  useEffect(() => sponsorPreferencesChanged.subscribe(setConsent), []);
  const free = isFreeAcode();
  const available = useSponsorOptInAvailable(free && sponsorsConfigured() && consent !== "allowed");
  // An opted-in user can always withdraw, including when the native bridge goes offline.
  if (!free || (consent !== "allowed" && !available)) return null;
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
