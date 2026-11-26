// WebView keys read synchronously by Elo 0.8.1 during init().
export const iabKeys = [
  "IABTCF_gdprApplies",
  "IABTCF_TCString",
  "IABTCF_AddtlConsent",
  "IABGPP_HDR_GppString",
  "IABGPP_GppSID",
] as const;

const purposeKeys = ["IABTCF_PurposeConsents", "IABTCF_PurposeLegitimateInterests"] as const;
export type IabSignals = Partial<
  Record<(typeof iabKeys)[number], string | number | null> &
    Record<(typeof purposeKeys)[number], string | null>
>;
const allowed = new Set<string>([...iabKeys, ...purposeKeys]);

// Read through the host's file API. Never write to UMP's preferences or retain
// unrelated app preferences. A missing/unstable file is not a consent decision.
export async function readAndroidConsentSignals(
  signal?: AbortSignal,
): Promise<IabSignals | undefined> {
  const host = globalThis as {
    cordova?: { platformId?: string; file?: { applicationStorageDirectory?: string } };
    BuildInfo?: { packageName?: string };
  };
  if (host.cordova?.platformId !== "android") return undefined;
  const root = host.cordova.file?.applicationStorageDirectory;
  const packageName = host.BuildInfo?.packageName;
  if (!root?.startsWith("file:///") || !packageName || !/^[\w]+(?:\.[\w]+)+$/.test(packageName))
    throw new Error("Android consent storage unavailable");
  const path = `${root.replace(/\/$/, "")}/shared_prefs/${packageName}_preferences.xml`;
  const file = acode.require("fsOperation")(path);
  if (signal?.aborted) throw new Error("Consent read cancelled");
  const firstXml = await file.readFile("utf-8");
  const first = parseConsentPreferences(firstXml);
  if (signal?.aborted) throw new Error("Consent read cancelled");
  const secondXml = await file.readFile("utf-8");
  if (signal?.aborted) throw new Error("Consent read cancelled");
  // Unrelated host settings may change without changing the consent snapshot.
  if (
    firstXml !== secondXml &&
    JSON.stringify(first) !== JSON.stringify(parseConsentPreferences(secondXml))
  )
    throw new Error("Consent changed while reading preferences");
  return first;
}

export function parseConsentPreferences(xml: unknown): IabSignals {
  if (typeof xml !== "string" || xml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Invalid consent preferences");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror") || document.documentElement?.tagName !== "map")
    throw new Error("Invalid consent preferences");
  const values = new Map<string, string>();
  for (const entry of document.documentElement.children) {
    const name = entry.getAttribute("name");
    if (!name || !allowed.has(name)) continue;
    if (values.has(name) || entry.children.length || !["string", "int"].includes(entry.tagName))
      throw new Error("Invalid consent preference value");
    const value = entry.tagName === "int" ? entry.getAttribute("value") : entry.textContent;
    if (value === null) throw new Error("Missing consent preference value");
    values.set(name, value.trim());
  }
  return Object.fromEntries(
    [...allowed].filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
  );
}
