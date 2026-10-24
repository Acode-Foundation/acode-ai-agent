import { afterEach, expect, test, vi } from "vitest";
import { formatSnapshot, offLimitsReason, riskOf, type UiItem } from "../src/tools/acodeUi";

const approval = vi.hoisted(() => ({
  value: { title: "", preview: "" } as {
    risk?: "change" | "risky";
    title: string;
    preview: string;
  },
}));

vi.mock("../src/tools/acodeUi", async (importActual) => ({
  ...(await importActual<typeof import("../src/tools/acodeUi")>()),
  acodeUiApproval: () => approval.value,
  clearHighlight: () => {},
}));

const { MutationGate } = await import("../src/permissions/mutationGate");

afterEach(() => {
  approval.value = { title: "", preview: "" };
});

const item = (overrides: Partial<UiItem>): UiItem => ({ kind: "button", label: "x", ...overrides });

test("opening pages, menus and lists, dismissing dialogs and switching tabs are free", () => {
  expect(riskOf(item({ kind: "setting", label: "Editor settings", opens: true }), "click")).toBe(
    "free",
  );
  expect(riskOf(item({ label: "more vert", action: "toggle-menu" }), "click")).toBe("free");
  expect(riskOf(item({ kind: "tab", label: "index.html" }), "click")).toBe("free");
  expect(riskOf(item({ label: "Cancel", inDialog: true }), "click")).toBe("free");
});

test("toggles, picked options and unknown buttons are changes", () => {
  expect(riskOf(item({ kind: "toggle", label: "Text wrap" }), "click")).toBe("change");
  expect(riskOf(item({ kind: "option", label: "Dark", inDialog: true }), "click")).toBe("change");
  expect(riskOf(item({ label: "Install" }), "click")).toBe("change");
});

test("destructive taps, confirming a dialog, and typing are risky", () => {
  expect(
    riskOf(item({ kind: "setting", label: "Restore default settings", opens: true }), "click"),
  ).toBe("risky");
  expect(riskOf(item({ label: "Uninstall" }), "click")).toBe("risky");
  expect(riskOf(item({ label: "Exit", action: "exit" }), "click")).toBe("risky");
  expect(riskOf(item({ label: "OK", inDialog: true }), "click")).toBe("risky");
  expect(riskOf(item({ kind: "input", label: "Font size", inDialog: true }), "type")).toBe("risky");
});

test("purchases, ads and sponsorship are off limits", () => {
  expect(
    offLimitsReason(item({ kind: "setting", label: "Remove ads", key: "removeads" })),
  ).toContain("purchases, ads");
  expect(offLimitsReason(item({ label: "Buy Pro" }))).toBeDefined();
  expect(offLimitsReason(item({ label: "Editor settings" }))).toBeUndefined();
});

test("snapshots number items with their kind, state, value and key", () => {
  expect(
    formatSnapshot({ kind: "page", title: "Editor settings" }, [
      item({ kind: "toggle", label: "Text wrap", key: "textWrap", checked: true }),
      item({ kind: "setting", label: "Font size", key: "fontSize", value: "12px", opens: true }),
      item({ kind: "input", label: "Password", value: "secret", password: true, inDialog: true }),
    ]),
  ).toBe(
    [
      "Screen: page — Editor settings",
      '[1] toggle "Text wrap" on (textWrap)',
      '[2] setting "Font size" = "12px" (fontSize) → opens',
      '[3] input "Password" = (hidden)',
    ].join("\n"),
  );
});

test("risky UI actions ask even in Full access and are never granted for the session", async () => {
  const gate = new MutationGate();
  approval.value = { risk: "risky", title: "Tap in Acode: OK", preview: 'Tap button "OK"' };
  const workspace = {} as never;

  const first = gate.request("acode_ui", { action: "click", ref: 1 }, workspace, "full-access");
  await vi.waitFor(() => expect(gate.pending).toBeDefined());
  expect(gate.pending).toMatchObject({ title: "Tap in Acode: OK", once: true });
  gate.resolve("allow-session");
  expect(await first).toEqual({});

  const second = gate.request("acode_ui", { action: "click", ref: 1 }, workspace, "full-access");
  await vi.waitFor(() => expect(gate.pending).toBeDefined());
  gate.resolve("deny");
  expect(await second).toMatchObject({ block: true });
});

test("UI changes follow the permission mode and free actions never ask", async () => {
  const gate = new MutationGate();
  const workspace = {} as never;
  const click = (mode: "ask" | "full-access") =>
    gate.request("acode_ui", { action: "click", ref: 2 }, workspace, mode);

  expect(await click("ask")).toEqual({});

  approval.value = { risk: "change", title: "Tap in Acode: Text wrap", preview: "" };
  expect(await click("full-access")).toEqual({});
  const asked = click("ask");
  await vi.waitFor(() => expect(gate.pending).toBeDefined());
  expect(gate.pending?.once).toBeUndefined();
  gate.resolve("allow-session");
  expect(await asked).toEqual({});
  expect(await click("ask")).toEqual({});
});

test("typing a search follows the permission mode; other typing and replacing stay risky", () => {
  expect(riskOf(item({ kind: "input", label: "Search", search: true }), "type")).toBe("change");
  expect(riskOf(item({ kind: "input", label: "Replace", search: true }), "type")).toBe("risky");
  expect(riskOf(item({ kind: "input", label: "Font size", inDialog: true }), "type")).toBe("risky");
  expect(riskOf(item({ label: "Replace all" }), "click")).toBe("risky");
  expect(riskOf(item({ label: "Plugins", action: "sidebar-app" }), "click")).toBe("free");
});
