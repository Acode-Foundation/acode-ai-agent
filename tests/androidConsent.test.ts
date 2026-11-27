// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  parseConsentPreferences,
  readAndroidConsentSignals,
} from "../src/suggestions/androidConsent";
import { readSponsorConsent, withSponsorConsent } from "../src/suggestions/consent";

const accepted =
  '<map><int name="IABTCF_gdprApplies" value="1"/><string name="IABTCF_TCString">TC</string><string name="IABTCF_PurposeConsents">110000100000000000000000</string></map>';
let readFile: ReturnType<typeof vi.fn>;
let getState: ReturnType<typeof vi.fn>;
let fs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  readFile = vi.fn(async () => accepted);
  getState = vi.fn(async () => ({ consentStatus: "obtained", canRequestAds: true }));
  fs = vi.fn(() => ({ readFile }));
  vi.stubGlobal("cordova", {
    platformId: "android",
    file: { applicationStorageDirectory: "file:///data/user/12/com.example.editor/" },
  });
  vi.stubGlobal("BuildInfo", { packageName: "com.example.editor" });
  vi.stubGlobal("acode", {
    require: (name: string) => {
      expect(name).toBe("fsOperation");
      return fs;
    },
  });
  vi.stubGlobal("admob", { privacy: { getState } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const read = () => readSponsorConsent(new AbortController().signal);

test("reads actual host paths, forwards IAB values and restores shared storage", async () => {
  const xml = accepted.replace(
    "</map>",
    '<string name="IABTCF_AddtlConsent">2~1.2</string><string name="IABGPP_HDR_GppString">GPP</string><string name="IABGPP_GppSID">7_8</string><string name="private-token">never-return</string></map>',
  );
  readFile.mockResolvedValue(xml);
  const result = await read();
  expect(fs).toHaveBeenCalledWith(
    "file:///data/user/12/com.example.editor/shared_prefs/com.example.editor_preferences.xml",
  );
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(getState).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ status: "allowed", signals: ["1", "TC", "2~1.2", "GPP", "7_8"] });
  expect(await readAndroidConsentSignals()).not.toHaveProperty("private-token");
  localStorage.setItem("IABTCF_TCString", "host-value");
  if (result.status !== "allowed") throw Error("Expected permission");
  withSponsorConsent(result.signals, () =>
    expect(localStorage.getItem("IABTCF_TCString")).toBe("TC"),
  );
  expect(localStorage.getItem("IABTCF_TCString")).toBe("host-value");
});

test("refusal clears identity even when UMP still allows limited ads", async () => {
  expect((await read()).status).toBe("allowed");
  localStorage.setItem("elo_visitor_id", "old-identity");
  readFile.mockResolvedValue(
    accepted.replace("110000100000000000000000", "000000000000000000000000"),
  );
  expect(await read()).toEqual({ status: "denied" });
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
});

test.each([
  accepted.replace('<string name="IABTCF_TCString">TC</string>', ""),
  accepted.replace('<string name="IABTCF_PurposeConsents">110000100000000000000000</string>', ""),
  accepted.replace('value="1"', 'value="2"'),
  accepted.replace("</map>", '<string name="IABGPP_HDR_GppString">GPP</string></map>'),
  accepted.replace("</map>", '<string name="IABGPP_GppSID">7</string></map>'),
  "<map/>",
])("blocks incomplete or malformed signals %s", async (xml) => {
  readFile.mockResolvedValue(xml);
  expect(await read()).toMatchObject({ status: "unavailable" });
});

test("non-EEA state forwards available GPP without inventing a TC string", async () => {
  getState.mockResolvedValue({ consentStatus: "notRequired", canRequestAds: true });
  readFile.mockResolvedValue(
    '<map><int name="IABTCF_gdprApplies" value="0"/><string name="IABGPP_HDR_GppString">GPP</string><string name="IABGPP_GppSID">7</string></map>',
  );
  expect(await read()).toEqual({ status: "allowed", signals: ["0", null, null, "GPP", "7"] });
});

test("does not read files for a native denial or an existing host snapshot", async () => {
  getState.mockResolvedValueOnce({ consentStatus: "required", canRequestAds: false });
  expect((await read()).status).toBe("denied");
  getState.mockResolvedValueOnce({
    consentStatus: "obtained",
    canRequestAds: true,
    iabSignals: { IABTCF_gdprApplies: "0" },
  });
  expect((await read()).status).toBe("allowed");
  expect(readFile).not.toHaveBeenCalled();
});

test("blocks a file changing during the read and a changing native state", async () => {
  readFile.mockResolvedValueOnce(accepted).mockResolvedValueOnce(accepted.replace(">TC<", ">NEW<"));
  expect((await read()).status).toBe("unavailable");
  getState
    .mockResolvedValueOnce({ consentStatus: "obtained", canRequestAds: true })
    .mockResolvedValueOnce({ consentStatus: "required", canRequestAds: false });
  expect((await read()).status).toBe("denied");
});

test("fails closed on file access errors, including outside EEA", async () => {
  getState.mockResolvedValue({ consentStatus: "notRequired", canRequestAds: true });
  readFile.mockRejectedValue(Error("Permission denied"));
  expect((await read()).status).toBe("unavailable");
});

test("does not attempt Android paths on iOS or accept path injection", async () => {
  vi.stubGlobal("cordova", { platformId: "ios" });
  expect(await readAndroidConsentSignals()).toBeUndefined();
  vi.stubGlobal("cordova", {
    platformId: "android",
    file: { applicationStorageDirectory: "file:///data/user/0/app/" },
  });
  vi.stubGlobal("BuildInfo", { packageName: "../../other" });
  expect((await read()).status).toBe("unavailable");
  expect(fs).not.toHaveBeenCalled();
});

test("the three-second deadline covers the file read; cancellation drops late results", async () => {
  vi.useFakeTimers();
  let finish!: (xml: string) => void;
  readFile.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const request = read();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await request).toMatchObject({ status: "unavailable", reason: "timeout" });
  finish(accepted);
  const abort = new AbortController();
  const next = readSponsorConsent(abort.signal);
  abort.abort();
  expect(await next).toMatchObject({ status: "unavailable", reason: "aborted" });
});

test.each([
  "<other/>",
  "<map><string></map>",
  "<!DOCTYPE map><map/>",
  accepted.replace("</map>", '<int name="IABTCF_gdprApplies" value="0"/></map>'),
  '<map><boolean name="IABTCF_gdprApplies" value="true"/></map>',
  '<map><string name="IABTCF_TCString"><value>TC</value></string></map>',
])("rejects invalid preference XML %s", (xml) => {
  expect(() => parseConsentPreferences(xml)).toThrow();
});

test("decodes XML entities but never returns unrelated preferences", () => {
  expect(
    parseConsentPreferences(
      '<map><string name="IABTCF_TCString">a&amp;b</string><string name="secret">hidden</string></map>',
    ),
  ).toEqual({ IABTCF_TCString: "a&b" });
});

test("normalizes a mid-read required status and clears the identity", async () => {
  localStorage.setItem("elo_visitor_id", "previous");
  getState
    .mockResolvedValueOnce({ consentStatus: "obtained", canRequestAds: true })
    .mockResolvedValueOnce({ consentStatus: " Required ", canRequestAds: true });
  expect(await read()).toEqual({ status: "denied" });
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
});

test("a later native snapshot takes precedence over the file snapshot", async () => {
  getState
    .mockResolvedValueOnce({ consentStatus: "obtained", canRequestAds: true })
    .mockResolvedValueOnce({
      consentStatus: "obtained",
      canRequestAds: true,
      iabSignals: { IABTCF_gdprApplies: "1", IABTCF_TCString: "new-native" },
    });
  expect(await read()).toEqual({
    status: "allowed",
    signals: ["1", "new-native", null, null, null],
  });
});

test("aborting during file I/O settles promptly and does not start a second read", async () => {
  let finish!: (value: string) => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  readFile.mockImplementation(() => {
    started();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const controller = new AbortController();
  const result = readSponsorConsent(controller.signal);
  await pending;
  controller.abort();
  expect(await result).toMatchObject({ status: "unavailable", reason: "aborted" });
  finish(accepted);
  await Promise.resolve();
  await Promise.resolve();
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(getState).toHaveBeenCalledTimes(1);
});

test("GPP without explicit GDPR applicability remains unavailable", async () => {
  getState.mockResolvedValue({ consentStatus: "notRequired", canRequestAds: true });
  readFile.mockResolvedValue(
    '<map><string name="IABGPP_HDR_GppString">GPP</string><string name="IABGPP_GppSID">7</string></map>',
  );
  expect(await read()).toMatchObject({ status: "unavailable" });
});

test.each(["", "1x"])("rejects an invalid purpose bit string %s", async (purposes) => {
  readFile.mockResolvedValue(accepted.replace("110000100000000000000000", purposes));
  expect(await read()).toMatchObject({ status: "unavailable" });
});

test.each(["7-8", "0"])("rejects malformed GPP sections %s", async (sections) => {
  readFile.mockResolvedValue(
    accepted.replace(
      "</map>",
      `<string name="IABGPP_HDR_GppString">GPP</string><string name="IABGPP_GppSID">${sections}</string></map>`,
    ),
  );
  expect(await read()).toMatchObject({ status: "unavailable" });
});

test("unrelated preference changes do not invalidate unchanged IAB values", async () => {
  readFile
    .mockResolvedValueOnce(accepted)
    .mockResolvedValueOnce(
      accepted.replace("</map>", '<string name="editor-theme">dark</string></map>'),
    );
  expect((await read()).status).toBe("allowed");
});

test.each(["1100001", "11111111111", "110000100000000000000000"])(
  "checks Purposes 1, 2 and 7 without assuming a fixed length: %s",
  async (purposes) => {
    readFile.mockResolvedValue(accepted.replace("110000100000000000000000", purposes));
    expect((await read()).status).toBe("allowed");
  },
);

test("a native GPP snapshot must include both the string and section IDs", async () => {
  getState.mockResolvedValue({
    consentStatus: "obtained",
    canRequestAds: true,
    iabSignals: { IABTCF_gdprApplies: "0", IABGPP_HDR_GppString: "GPP" },
  });
  expect(await read()).toMatchObject({ status: "unavailable" });
  expect(readFile).not.toHaveBeenCalled();
});

test("rejects oversized preference documents before parsing", () => {
  const xml = '<map><string name="IABTCF_TCString">' + "A".repeat(1_048_576) + "</string></map>";
  expect(() => parseConsentPreferences(xml)).toThrow("Invalid consent preferences");
});

test.each([
  ["obtained", "unavailable"],
  ["notRequired", "allowed"],
])("an empty native snapshot is authoritative for %s", async (consentStatus, expected) => {
  getState.mockResolvedValue({ consentStatus, canRequestAds: true, iabSignals: {} });
  const result = await read();
  expect(result.status).toBe(expected);
  expect(readFile).not.toHaveBeenCalled();
  if (result.status === "allowed") expect(result.signals).toEqual([null, null, null, null, null]);
});

test.each(["1", "100000100000", "110000000000"])(
  "denies basic ads without consent or legitimate interest for Purposes 2 and 7: %s",
  async (purposes) => {
    localStorage.setItem("elo_visitor_id", "old-identity");
    readFile.mockResolvedValue(
      accepted
        .replace("110000100000000000000000", purposes)
        .replace(
          "</map>",
          '<string name="IABTCF_PurposeLegitimateInterests">0000000000000</string></map>',
        ),
    );
    expect(await read()).toEqual({ status: "denied" });
    expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  },
);

test("accepts legitimate interest for Purposes 2 and 7 but not for Purpose 1", async () => {
  const withInterests = (consents: string, interests: string) =>
    accepted
      .replace("110000100000000000000000", consents)
      .replace(
        "</map>",
        `<string name="IABTCF_PurposeLegitimateInterests">${interests}</string></map>`,
      );
  readFile.mockResolvedValue(withInterests("1000000", "0100001"));
  expect((await read()).status).toBe("allowed");
  readFile.mockResolvedValue(withInterests("0000000", "1100001"));
  expect((await read()).status).toBe("denied");
  readFile.mockResolvedValue(withInterests("1100001", "1x"));
  expect((await read()).status).toBe("unavailable");
});

test("a host snapshot with purpose bits must allow basic ads", async () => {
  const snapshot = (IABTCF_PurposeConsents: string) => ({
    consentStatus: "obtained",
    canRequestAds: true,
    iabSignals: {
      IABTCF_gdprApplies: "1",
      IABTCF_TCString: "TC",
      IABTCF_PurposeConsents,
      IABTCF_PurposeLegitimateInterests: "0000000",
    },
  });
  localStorage.setItem("elo_visitor_id", "old-identity");
  getState.mockResolvedValue(snapshot("1000000"));
  expect(await read()).toEqual({ status: "denied" });
  expect(localStorage.getItem("elo_visitor_id")).toBeNull();
  getState.mockResolvedValue(snapshot("1100001"));
  expect((await read()).status).toBe("allowed");
  expect(readFile).not.toHaveBeenCalled();
});

test("missing LI bits pause ads without clearing the identity when Purposes 2/7 lack consent", async () => {
  localStorage.setItem("elo_visitor_id", "old-identity");
  readFile.mockResolvedValue(accepted.replace("110000100000000000000000", "1000000"));
  expect(await read()).toMatchObject({ status: "unavailable" });
  expect(localStorage.getItem("elo_visitor_id")).toBe("old-identity");
});

test("host snapshot purpose bits must be strings and LI gaps pause instead of denying", async () => {
  const snapshot = (signals: Record<string, unknown>) => ({
    consentStatus: "obtained",
    canRequestAds: true,
    iabSignals: { IABTCF_gdprApplies: "1", IABTCF_TCString: "TC", ...signals },
  });
  localStorage.setItem("elo_visitor_id", "old-identity");
  // 0110001 as a number would lose its leading zero and shift every purpose.
  getState.mockResolvedValue(snapshot({ IABTCF_PurposeConsents: 110001 }));
  expect(await read()).toMatchObject({ status: "unavailable" });
  getState.mockResolvedValue(
    snapshot({ IABTCF_PurposeConsents: "1100001", IABTCF_PurposeLegitimateInterests: 1 }),
  );
  expect(await read()).toMatchObject({ status: "unavailable" });
  // Purposes present, LI absent or empty: Purpose 2/7 gaps pause ads and keep the identifier.
  getState.mockResolvedValue(snapshot({ IABTCF_PurposeConsents: "1000000" }));
  expect(await read()).toMatchObject({ status: "unavailable" });
  getState.mockResolvedValue(
    snapshot({ IABTCF_PurposeConsents: "1000000", IABTCF_PurposeLegitimateInterests: " " }),
  );
  expect(await read()).toMatchObject({ status: "unavailable" });
  expect(localStorage.getItem("elo_visitor_id")).toBe("old-identity");
  // Untrimmed host values are accepted once trimmed.
  getState.mockResolvedValue(snapshot({ IABTCF_PurposeConsents: " 1100001 " }));
  expect((await read()).status).toBe("allowed");
  expect(readFile).not.toHaveBeenCalled();
});
