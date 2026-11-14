import { clearSponsorIdentity } from "./preferences";

// These are the WebView keys read by Elo 0.8.0 during init().
const keys = [
  "IABTCF_gdprApplies",
  "IABTCF_TCString",
  "IABTCF_AddtlConsent",
  "IABGPP_HDR_GppString",
  "IABGPP_GppSID",
] as const;

type NativePrivacyState = {
  consentStatus: string;
  canRequestAds: boolean;
  // Optional full snapshot from the host. Missing entries in a snapshot are cleared.
  iabSignals?: Partial<Record<(typeof keys)[number], string | number | null>>;
};

export type ConsentSignals = (string | null)[];

type ConsentResult =
  | { status: "allowed"; signals: ConsentSignals }
  | { status: "denied" | "unavailable" };

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
  if (signal.aborted || !read) return { status: "unavailable" };
  let cancel!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    cancel = () => resolve(null);
  });
  const timer = setTimeout(cancel, 3000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const state = await Promise.race([read(), cancelled]);
    if (signal.aborted || !state) return { status: "unavailable" };
    const status = state.consentStatus?.trim().toLowerCase();
    if (!["required", "obtained", "notrequired", "not_required"].includes(status))
      return { status: "unavailable" };
    if (status === "required" || state.canRequestAds === false) {
      clearSponsorIdentity();
      return { status: "denied" };
    }
    if (state.canRequestAds !== true) return { status: "unavailable" };
    const signals = keys.map((key) => String(state.iabSignals?.[key] ?? "").trim() || null);
    const [applies, tcString] = signals;
    if ((applies !== null || status === "obtained") && applies !== "0" && applies !== "1")
      return { status: "unavailable" };
    if (applies === "1" && !tcString) return { status: "unavailable" };
    return { status: "allowed", signals };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
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
