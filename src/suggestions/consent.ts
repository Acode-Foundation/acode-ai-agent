import { clearSponsorIdentity } from "./preferences";
import { iabKeys as keys, readAndroidConsentSignals, type IabSignals } from "./androidConsent";

type NativePrivacyState = {
  consentStatus: string;
  canRequestAds: boolean;
  // Optional full snapshot from the host. Missing entries in a snapshot are cleared.
  iabSignals?: IabSignals;
};

export type ConsentSignals = (string | null)[];

/** Why a native read did not complete; a refusal is a separate `denied` result. */
export type ConsentUnavailable = "timeout" | "aborted" | "bridge" | "invalid";

type ConsentResult =
  | { status: "allowed"; signals: ConsentSignals }
  | { status: "denied" }
  | { status: "unavailable"; reason: ConsentUnavailable };

function nativeConsentReader() {
  const host = globalThis as { admob?: { privacy?: { getState(): Promise<NativePrivacyState> } } };
  try {
    const privacy = host.admob?.privacy;
    return privacy?.getState?.bind(privacy);
  } catch {
    return undefined;
  }
}

export function hasSponsorConsentBridge(): boolean {
  return Boolean(nativeConsentReader());
}

// Lifecycle events and SDK callbacks for the same view can overlap. Only share
// unfinished reads so a later interaction always sees the current native state.
const pending = new WeakMap<AbortSignal, Promise<ConsentResult>>();

export function readSponsorConsent(signal: AbortSignal): Promise<ConsentResult> {
  const reading = pending.get(signal);
  if (reading) return reading;
  const next = readNativeConsent(signal).finally(() => pending.delete(signal));
  pending.set(signal, next);
  return next;
}

async function readNativeConsent(signal: AbortSignal): Promise<ConsentResult> {
  const read = nativeConsentReader();
  if (signal.aborted || !read)
    return { status: "unavailable", reason: signal.aborted ? "aborted" : "bridge" };
  const request = new AbortController();
  let stop: ConsentUnavailable | undefined;
  let cancel!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    cancel = () => {
      request.abort();
      resolve(null);
    };
  });
  const timer = setTimeout(() => {
    stop = "timeout";
    cancel();
  }, 3000);
  const aborted = () => {
    stop = "aborted";
    cancel();
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    const state = await Promise.race([readConsentState(read, request.signal), cancelled]);
    if (signal.aborted || !state)
      return {
        status: "unavailable",
        reason: stop ?? (signal.aborted ? "aborted" : "invalid"),
      };
    const status = normalizedStatus(state);
    if (!["required", "obtained", "notrequired"].includes(status))
      return { status: "unavailable", reason: "invalid" };
    if (status === "required" || state.canRequestAds === false) {
      clearSponsorIdentity();
      return { status: "denied" };
    }
    if (state.canRequestAds !== true) return { status: "unavailable", reason: "invalid" };
    const signals = keys.map((key) => String(state.iabSignals?.[key] ?? "").trim() || null);
    // Tuple order follows iabKeys, also used when installing the SDK's storage snapshot.
    const [applies, tcString, , gpp, sections] = signals;
    if ((applies !== null || status === "obtained") && applies !== "0" && applies !== "1")
      return { status: "unavailable", reason: "invalid" };
    // The Android file always carries purpose bits; a host snapshot is checked when it does.
    // A native snapshot without IABTCF_PurposeConsents is trusted as already validated by the
    // host. Supplied purpose values must be bit strings. LI is optional when consent covers
    // Purposes 2/7; missing or empty LI cannot establish refusal of those purposes.
    if (applies === "1" && state.iabSignals?.IABTCF_PurposeConsents != null) {
      const purposes = basicAdPurposes(state.iabSignals);
      if (purposes === "invalid") return { status: "unavailable", reason: "invalid" };
      if (purposes === "denied") {
        clearSponsorIdentity();
        return { status: "denied" };
      }
    }
    if (applies === "1" && !tcString) return { status: "unavailable", reason: "invalid" };
    if (
      Boolean(gpp) !== Boolean(sections) ||
      (sections && !/^(?:-1|[1-9]\d*(?:_[1-9]\d*)*)$/.test(sections))
    )
      return { status: "unavailable", reason: "invalid" };
    return { status: "allowed", signals };
  } catch {
    return { status: "unavailable", reason: stop ?? "bridge" };
  } finally {
    request.abort();
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
  }
}

// Basic ads need Purpose 1 (store and/or access information on a device) by consent, plus
// Purposes 2 (use limited data to select advertising) and 7 (measure advertising
// performance) by consent or legitimate interest.
// Elo confirmed Purposes 1, 2 and 7 are sufficient; Purposes 3/4 are not required, and
// Elo has no IAB vendor ID, so no vendor-level consent check applies.
function basicAdPurposes(signals: IabSignals): "allowed" | "denied" | "invalid" {
  const rawPurposes = signals.IABTCF_PurposeConsents;
  const rawInterests = signals.IABTCF_PurposeLegitimateInterests;
  // Bit strings only: a numeric value would drop leading zeros and shift purpose positions.
  if (typeof rawPurposes !== "string") return "invalid";
  if (rawInterests != null && typeof rawInterests !== "string") return "invalid";
  const purposes = rawPurposes.trim();
  // An empty LI value carries no decision, the same as a missing key.
  const interests = rawInterests?.trim() ?? "";
  if (!/^[01]+$/.test(purposes) || !/^[01]*$/.test(interests)) return "invalid";
  if (purposes[0] !== "1") return "denied";
  const granted = (purpose: number) =>
    purposes[purpose - 1] === "1" || interests[purpose - 1] === "1";
  if (granted(2) && granted(7)) return "allowed";
  // Without the LI bits, a missing Purpose 2/7 consent is not a definite refusal:
  // pause ads and keep the identifier rather than clearing it.
  return interests ? "denied" : "invalid";
}

function normalizedStatus(state: NativePrivacyState): string {
  return state.consentStatus?.trim().toLowerCase().replace("not_required", "notrequired");
}

async function readConsentState(read: () => Promise<NativePrivacyState>, signal: AbortSignal) {
  const initial = await read();
  if (
    signal.aborted ||
    initial.iabSignals ||
    initial.canRequestAds !== true ||
    normalizedStatus(initial) === "required"
  )
    return initial;
  const iabSignals = await readAndroidConsentSignals(signal);
  if (!iabSignals || signal.aborted) return initial;
  const latest = await read();
  if (
    latest.iabSignals ||
    latest.canRequestAds === false ||
    normalizedStatus(latest) === "required"
  )
    return latest;
  if (
    normalizedStatus(latest) !== normalizedStatus(initial) ||
    latest.canRequestAds !== initial.canRequestAds
  )
    return null;
  const applies = String(iabSignals.IABTCF_gdprApplies);
  if (!["0", "1"].includes(applies)) return null;
  if (applies === "1") {
    // Purpose bits are checked with the other signals once the native state is final.
    if (iabSignals.IABTCF_PurposeConsents == null) return null;
  }
  return { ...latest, iabSignals };
}

// Elo 0.8 reads localStorage synchronously at the start of init(). Other plugins
// share this storage, so restore their values before yielding to the event loop.
export function withSponsorConsent<T>(signals: ConsentSignals, init: () => T): T {
  const previous = keys.map((key) => localStorage.getItem(key));
  const write = (key: string, value: string | null) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  };
  try {
    keys.forEach((key, i) => {
      if (signals[i] !== previous[i]) write(key, signals[i]);
    });
    return init();
  } finally {
    const retry: number[] = [];
    keys.forEach((key, i) => {
      if (signals[i] === previous[i]) return;
      try {
        write(key, previous[i]);
      } catch {
        retry.push(i);
        // A quota error can block restoring a larger value while deletion still works.
        try {
          if (localStorage.getItem(key) === signals[i]) localStorage.removeItem(key);
        } catch {
          // Restore the remaining keys even if access to this one is blocked.
        }
      }
    });
    // Restoring the other keys may have freed enough space for the original value.
    for (const i of retry) {
      try {
        if (localStorage.getItem(keys[i]) === null) write(keys[i], previous[i]);
      } catch {
        // If storage remains unavailable, leave the temporary signal removed.
      }
    }
  }
}
