import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

export const ACODE_UI_TOOL = "acode_ui";

/** How much a UI action needs the user: never, per permission mode, or every time. */
export type UiRisk = "free" | "change" | "risky";

export type UiItemKind = "button" | "toggle" | "setting" | "option" | "input" | "tab" | "item";

/** What a snapshot knows about one element, without the element itself. */
export type UiItem = {
  kind: UiItemKind;
  label: string;
  /** Settings key, tab, or plugin id, when the element has one. */
  key?: string;
  /** Acode's `action` / `data-action` for the element, which says whether it only navigates. */
  action?: string;
  value?: string;
  checked?: boolean;
  /** The current tab, theme, or option. */
  selected?: boolean;
  /** Marked as paid (Acode's star icon); treated like a purchase. */
  premium?: boolean;
  /** The element sits in a dialog: OK-like buttons confirm what the dialog asks. */
  inDialog?: boolean;
  /** A settings row that opens a page, list, or prompt instead of changing a value. */
  opens?: boolean;
  password?: boolean;
  /** A search or filter box: typing there finds things and changes nothing. */
  search?: boolean;
};

export type UiLayer = {
  kind: "dialog" | "menu" | "sidebar" | "page" | "main";
  title: string;
  message?: string;
};

const DESTRUCTIVE =
  /\b(delete|remove|uninstall|reset|restore|clear|clean|erase|wipe|discard|logout|log out|sign out|exit|kill|terminate|revoke|unlink|overwrite|close all|replace)\b/i;
/** Money and ads: the tool never clicks these, whatever the user approves. */
const OFF_LIMITS =
  /\b(purchase|buy|pay|payment|subscribe|remove ads|ad-free|ad free|sponsor|rate acode|donate)\b/i;
const OFF_LIMITS_KEYS = new Set([
  "removeads",
  "restorePurchases",
  "adRewards",
  "rateapp",
  "sponsors",
  "privacyChoices",
]);
const DISMISS = /^(cancel|close|no|not now|later|dismiss|back)$/i;
/** Acode actions that only open or move between views. */
const NAVIGATION_ACTIONS = new Set([
  "toggle-sidebar",
  "toggle-menu",
  "toggle-edit-menu",
  "go-back",
  "open",
  "files",
  "recent",
  "find-file",
  "search",
  "list-item",
  "file-info",
  "lsp-info",
  "running-processes",
  "console",
  "sidebar-app",
]);

const MAX_ITEMS = 150;
const MAX_LABEL = 80;
const SETTLE_MS = 450;

/** Why an item is refused, or undefined when the tool may act on it. */
export function offLimitsReason(item: UiItem): string | undefined {
  if (
    item.premium ||
    [item.key, item.action].some((name) => name && OFF_LIMITS_KEYS.has(name)) ||
    item.key?.startsWith("promo-") ||
    OFF_LIMITS.test(`${item.label} ${item.key ?? ""} ${item.action ?? ""}`)
  )
    return `"${item.label}" involves purchases, ads, or sponsorship; ask the user to do it themselves.`;
  return undefined;
}

/**
 * Risky: destructive labels, confirming a dialog, and typing; these ask even in Full access.
 * Change: toggles, picked options and unknown buttons, which follow the permission mode.
 * Free: opening pages, menus and lists, dismissing dialogs, and switching tabs.
 */
export function riskOf(item: UiItem, action: "click" | "type"): UiRisk {
  const text = `${item.label} ${item.key ?? ""} ${item.action ?? ""}`;
  if (action === "type") return item.search && !DESTRUCTIVE.test(text) ? "change" : "risky";
  if (DESTRUCTIVE.test(text)) return "risky";
  if (item.inDialog) {
    if (item.kind === "option") return "change";
    if (item.kind === "input") return "free";
    return DISMISS.test(item.label.trim()) ? "free" : "risky";
  }
  if (item.kind === "toggle") return "change";
  if (item.kind === "tab" || (item.kind === "setting" && item.opens)) return "free";
  if (item.action && NAVIGATION_ACTIONS.has(item.action)) return "free";
  return "change";
}

export function formatSnapshot(layer: UiLayer, items: readonly UiItem[], truncated = 0): string {
  const head = [`Screen: ${layer.kind} — ${layer.title}`];
  if (layer.message && layer.message !== layer.title) head.push(`Message: ${layer.message}`);
  const lines = items.map((item, index) => `[${index + 1}] ${formatItem(item)}`);
  if (truncated) lines.push(`[${truncated} more not shown]`);
  if (!items.length) lines.push("(nothing to act on)");
  return [...head, ...lines].join("\n");
}

function formatItem(item: UiItem): string {
  const parts = [`${item.kind} "${item.label}"`];
  if (item.kind === "toggle") parts.push(item.checked ? "on" : "off");
  if (item.selected) parts.push("(selected)");
  if (item.premium) parts.push("(paid)");
  if (item.value !== undefined)
    parts.push(`= ${item.password ? "(hidden)" : JSON.stringify(item.value)}`);
  // Promotions carry an encoded URL as their key; it only adds noise.
  if (item.key?.startsWith("promo-")) parts.push("(ad)");
  else if (item.key) parts.push(`(${item.key})`);
  else if (item.action) parts.push(`(${item.action})`);
  if (item.opens) parts.push("→ opens");
  if (item.search) parts.push("(search box)");
  return parts.join(" ");
}

type Ref = { element: Element; item: UiItem };
type Snapshot = { id: number; layer: UiLayer; refs: Ref[] };

let latest: Snapshot | undefined;
let highlighted: Element | undefined;

/** What the approval prompt needs for an `acode_ui` call; `undefined` risk asks nothing. */
export function acodeUiApproval(args: Record<string, unknown>): {
  risk?: Exclude<UiRisk, "free">;
  title: string;
  preview: string;
} {
  const action = args.action === "type" ? "type" : args.action === "click" ? "click" : undefined;
  if (!action) return { title: "", preview: "" };
  const ref = resolveRef(args.ref);
  if (!ref) return { title: "", preview: "" };
  if (offLimitsReason(ref.item)) return { title: "", preview: "" };
  const risk = riskOf(ref.item, action);
  if (risk === "free") return { title: "", preview: "" };
  highlight(ref.element);
  const where = `${latest!.layer.kind}: ${latest!.layer.title}`;
  if (action === "type") {
    const submit = args.submit === true ? " and press OK" : "";
    return {
      risk,
      title: `Type in Acode: ${ref.item.label}`,
      preview: `Type ${JSON.stringify(String(args.text ?? ""))} into "${ref.item.label}"${submit}\nOn ${where}`,
    };
  }
  return {
    risk,
    title: `Tap in Acode: ${ref.item.label}`,
    preview: `Tap ${ref.item.kind} "${ref.item.label}"${ref.item.key ? ` (${ref.item.key})` : ""}\nOn ${where}${latest!.layer.message ? `\n${latest!.layer.message}` : ""}`,
  };
}

/**
 * `acode_ui`: read what Acode shows and act on it like the user would. For tasks no command or
 * setting covers; each action returns the screen it leads to.
 */
export function createAcodeUiTool(): ToolRegistration {
  return defineTool({
    name: ACODE_UI_TOOL,
    description:
      "See and operate Acode's UI when no Acode command or setting does the job: 'snapshot' lists the top screen " +
      "(dialog, menu, page, or main view) with numbered items; 'click' and 'type' act on an item from the latest " +
      "snapshot; 'back' closes the top dialog, menu, or page. Each action returns the next snapshot. Opening pages " +
      "is free; changes ask per the permission mode; confirming dialogs, typing, and destructive taps always ask. " +
      "Purchases and ads are off limits.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("snapshot"),
          Type.Literal("click"),
          Type.Literal("type"),
          Type.Literal("back"),
        ],
        { description: "snapshot | click | type | back" },
      ),
      ref: Type.Optional(Type.Number({ description: "Item number from the latest snapshot" })),
      text: Type.Optional(
        Type.String({ description: "Text to type (replaces the field's value)" }),
      ),
      submit: Type.Optional(
        Type.Boolean({ description: "After typing, press the dialog's OK button" }),
      ),
    }),
    executionMode: "sequential",
    execute: async (args, _api, context) => {
      const signal = context.abortSignal;
      clearHighlight();
      switch (args.action) {
        case "snapshot":
          return result(takeSnapshot());
        case "back": {
          const stack = acode.require("actionStack") as Acode.ActionStack | undefined;
          if (!stack) throw new Error("Acode's back stack is unavailable.");
          // An empty stack would ask to close the app.
          if (!stack.length) throw new Error("Nothing to go back to; this is Acode's main screen.");
          stack.pop();
          await settle(signal);
          return result(`Went back.\n\n${takeSnapshot()}`);
        }
        case "click": {
          const ref = requireRef(args.ref);
          const refused = offLimitsReason(ref.item);
          if (refused) throw new Error(refused);
          if (ref.element instanceof HTMLElement) ref.element.scrollIntoView({ block: "nearest" });
          (ref.element as HTMLElement).click();
          await settle(signal);
          return result(`Tapped "${ref.item.label}".\n\n${takeSnapshot()}`);
        }
        case "type": {
          const ref = requireRef(args.ref);
          const field = ref.element;
          if (!isTextField(field)) throw new Error(`Item ${args.ref} is not a text field.`);
          setFieldValue(field as HTMLInputElement | HTMLTextAreaElement, args.text ?? "");
          if (args.submit) {
            const ok = dialogOf(field)?.querySelector<HTMLElement>(
              ".button-container button[type=submit], .button-container button:last-child",
            );
            if (!ok) throw new Error("Typed the text, but found no OK button to press.");
            ok.click();
          }
          await settle(signal);
          return result(
            `Typed into "${ref.item.label}"${args.submit ? " and pressed OK" : ""}.\n\n${takeSnapshot()}`,
          );
        }
        default:
          throw new Error("action must be snapshot, click, type or back.");
      }
    },
  });
}

function result(text: string): ToolExecutionResult<{ operation: string }> {
  return { output: [{ type: "text", text }], details: { operation: "acode_ui" } };
}

function resolveRef(ref: unknown): Ref | undefined {
  if (!latest || typeof ref !== "number") return undefined;
  const found = latest.refs[ref - 1];
  return found?.element.isConnected ? found : undefined;
}

function requireRef(ref: number | undefined): Ref {
  if (ref === undefined) throw new Error("Pass ref, an item number from the latest snapshot.");
  if (!latest) throw new Error("Take a snapshot first.");
  const found = resolveRef(ref);
  if (!found)
    throw new Error(`Item ${ref} is gone or not in the latest snapshot; take a new snapshot.`);
  return found;
}

function settle(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, SETTLE_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Operation aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function highlight(element: Element): void {
  clearHighlight();
  element.setAttribute("data-acode-agent-target", "");
  highlighted = element;
}

/** Drops the outline the approval prompt put on its target. */
export function clearHighlight(): void {
  highlighted?.removeAttribute("data-acode-agent-target");
  highlighted = undefined;
}

/** Fires the events Acode's dialogs listen for, as typing would. */
function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

// --- Reading the screen ---

/** Never listed: the agent's own UI, editor text, terminals, and quick tools. */
const EXCLUDED =
  ".acode-agent-root, .acode-agent-pill, .cm-editor, .xterm, #quick-tools, .ace_editor";
/** Clickable by markup. Tab bars are `.options` children, as Acode's TabView renders them. */
const CANDIDATES =
  "button, a[href], input, textarea, select, [action]:not(form), [data-action], [role=button], [role=tab], [role=switch], [data-tab], .list-item, .tile:not(header), .options > :not(.tab-indicator), .prompt li, .context-menu li";
/** A candidate inside one of these is part of it, except fields. */
// `form[action]` is HTML's submit target (Acode's prompt dialog), not an Acode action.
const CONTAINERS =
  "button, a[href], li, .list-item, [action]:not(form), [data-action], [role=button]";
const FOCUSABLE = "[tabindex]:not([tabindex='-1'])";

function takeSnapshot(): string {
  const { root, layer } = topLayer();
  const refs: Ref[] = [];
  let truncated = 0;
  for (const element of candidates(root)) {
    const item = describe(element, layer.kind === "dialog");
    if (!item.label) continue;
    if (refs.length >= MAX_ITEMS) {
      truncated++;
      continue;
    }
    refs.push({ element, item });
  }
  latest = { id: (latest?.id ?? 0) + 1, layer, refs };
  return formatSnapshot(
    layer,
    refs.map((ref) => ref.item),
    truncated,
  );
}

/**
 * Clickable elements in document order. Besides markup, Acode wires many controls with an
 * `onclick` property (plugin switches, theme rows, some tabs), and those count too, unless they
 * hold other controls: then they only delegate their children's clicks. A control inside a row
 * belongs to the row, except text fields and controls with their own handler.
 */
function candidates(root: Element): Element[] {
  const found: { element: Element; own: boolean }[] = [];
  for (const element of root.querySelectorAll("*")) {
    if (element.closest(EXCLUDED)) continue;
    const marked = element.matches(CANDIDATES);
    const own = typeof (element as HTMLElement).onclick === "function";
    if (marked || own || element.matches(FOCUSABLE)) found.push({ element, own: own && !marked });
  }
  const holders = new Set<Element>();
  for (const { element } of found)
    for (
      let parent = element.parentElement;
      parent && parent !== root;
      parent = parent.parentElement
    )
      holders.add(parent);
  return found
    .filter(({ element, own }) => {
      if (!isVisible(element)) return false;
      const marked = element.matches(CANDIDATES);
      if (!marked && holders.has(element)) return false;
      const container = element.parentElement?.closest(CONTAINERS);
      if (container && container !== root && root.contains(container))
        return isTextField(element) || own;
      return true;
    })
    .map(({ element }) => element);
}
/**
 * What covers the editor: a dialog, menu, sidebar, or page, topmost first; `undefined` for none.
 * On phones the open sidebar slides over the editor (and pages), hiding the chat's prompts.
 */
export function coveringLayer(): "dialog" | "menu" | "sidebar" | "page" | undefined {
  if (openDialogs().length) return "dialog";
  if (openMenus().length) return "menu";
  if (openSidebar()) return "sidebar";
  return openPages().length ? "page" : undefined;
}

/** Pages, menus and the phone sidebar above the editor, which the back stack closes one at a time. */
export function closablePageCount(): number {
  return openPages().length + openMenus().length + (openSidebar() ? 1 : 0);
}

/** The sidebar while it overlays the editor; on wide screens it sits beside it instead. */
function openSidebar(): Element | null {
  return document.querySelector("#sidebar.phone.show");
}

function openDialogs(): Element[] {
  return [...document.querySelectorAll(".prompt:not(.hide)")];
}

function openMenus(): Element[] {
  return [...document.querySelectorAll(".context-menu:not(.hide)")];
}

function openPages(): Element[] {
  return [...document.querySelectorAll("wc-page:not(.primary)")].filter(
    (element) => !element.classList.contains("hide") && isVisible(element),
  );
}

function topLayer(): { root: Element; layer: UiLayer } {
  const dialog = last(openDialogs());
  if (dialog) {
    const message = text(dialog.querySelector(".message")).slice(0, 600) || undefined;
    // Prompts carry their question as the message, with no title.
    const title =
      text(dialog.querySelector(".title")) ||
      (message && message.length <= 60 ? message : undefined) ||
      (dialog.classList.contains("select") ? "Choose" : "Dialog");
    return { root: dialog, layer: { kind: "dialog", title, ...(message ? { message } : {}) } };
  }
  const menu = last(openMenus());
  if (menu) return { root: menu, layer: { kind: "menu", title: "Menu" } };
  const sidebar = openSidebar();
  if (sidebar) {
    const app = sidebar.querySelector(".app-icons-container .active")?.getAttribute("title");
    return {
      root: sidebar,
      layer: { kind: "sidebar", title: app ? `Sidebar, ${app} app` : "Sidebar" },
    };
  }
  const page = last(openPages());
  if (page) {
    const title =
      page.getAttribute("data-title") || text(page.querySelector("header .text")) || "Page";
    return { root: page, layer: { kind: "page", title } };
  }
  // Here the sidebar, if shown, sits beside the editor (wide screens).
  const besideSidebar = document.querySelector("#sidebar.show");
  const active = window.editorManager?.activeFile?.filename;
  const title = `Acode${active ? `, active tab "${active}"` : ""}${besideSidebar ? ", sidebar open" : ""}`;
  return { root: document.body, layer: { kind: "main", title } };
}

function describe(element: Element, inDialog: boolean): UiItem {
  const action = element.getAttribute("action") ?? element.getAttribute("data-action") ?? undefined;
  const key =
    element.getAttribute("data-key") ??
    element.getAttribute("data-tab") ??
    element.getAttribute("data-id") ??
    element.getAttribute("data-type") ??
    undefined;
  const base = {
    ...(key ? { key } : {}),
    ...(action && action !== "list-item" ? { action } : {}),
    ...(inDialog ? { inDialog } : {}),
    ...(isSelected(element) ? { selected: true } : {}),
    ...(element.querySelector(".icon.stars") ? { premium: true } : {}),
  };
  if (isField(element)) {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    if (field instanceof HTMLInputElement && field.type === "checkbox")
      return { ...base, kind: "toggle", label: labelOf(field), checked: field.checked };
    return {
      ...base,
      kind: "input",
      label:
        field.getAttribute("placeholder") ||
        field.getAttribute("name") ||
        labelOf(field) ||
        // A prompt's question names its field.
        text(dialogOf(field)?.querySelector(".message") ?? null) ||
        "text field",
      value: field.value,
      ...(field instanceof HTMLInputElement && field.type === "password" ? { password: true } : {}),
      ...(isSearchField(field) ? { search: true } : {}),
    };
  }
  const switchState = element.getAttribute("aria-checked") ?? element.getAttribute("data-enabled");
  if (element.matches("[role=switch], [class*=toggle], [class*=switch]") && switchState !== null)
    return {
      ...base,
      kind: "toggle",
      label: labelOf(element) || `${rowLabel(element.closest(".list-item"))} switch`.trim(),
      checked: switchState === "true",
    };
  if (element.matches("[role=tab], [data-tab], .options > *"))
    return { ...base, kind: "tab", label: labelOf(element) };
  if (element.classList.contains("list-item")) {
    const label = rowLabel(element);
    const toggle = element.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (toggle) return { ...base, kind: "toggle", label, checked: toggle.checked };
    // Settings rows open a page, list, or prompt; other rows (plugins, themes) act or open as wired.
    if (!element.hasAttribute("data-key")) {
      const price = text(element.querySelector(".plugin-price")) || undefined;
      return { ...base, kind: "item", label, ...(price ? { value: price } : {}) };
    }
    // The row's subtitle is sometimes its description, so read the value Acode stores.
    const value =
      settingValue(element.getAttribute("data-key")!) ??
      (text(element.querySelector(".setting-value-display, .setting-trailing-value")) || undefined);
    return { ...base, kind: "setting", label, ...(value ? { value } : {}), opens: true };
  }
  if (inDialog && (element.tagName === "LI" || element.classList.contains("tile")))
    return { ...base, kind: "option", label: labelOf(element) };
  if (element.classList.contains("tile") && element.closest("#file-list, .open-file-list"))
    return { ...base, kind: "tab", label: labelOf(element) };
  return { ...base, kind: element.tagName === "LI" ? "item" : "button", label: labelOf(element) };
}

function settingValue(key: string): string | undefined {
  if (typeof acode === "undefined") return undefined;
  const values = (acode.require("settings") as Acode.Settings | undefined)?.value as
    | Record<string, unknown>
    | undefined;
  const value = values?.[key];
  if (value === undefined || (typeof value === "object" && value !== null)) return undefined;
  return String(value);
}

/** Where a row keeps its name: settings and themes use `.text`, plugins `.plugin-name`. */
const ROW_LABEL = ".text, .plugin-name, .name, .title";

function rowLabel(row: Element | null): string {
  return row ? text(row.querySelector(ROW_LABEL)) || labelOf(row) : "";
}

function isSelected(element: Element): boolean {
  return (
    element.classList.contains("active") ||
    element.classList.contains("selected") ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("checked") === "true"
  );
}
function labelOf(element: Element): string {
  const named =
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("data-title");
  if (named) return clip(named);
  const own = text(element);
  if (own) return clip(own);
  // Icon-only buttons: Acode's icon class names say what they are ("more_vert", "arrow_back").
  const icon = [...element.classList].find(
    (name) => name !== "icon" && element.classList.contains("icon"),
  );
  return icon ? icon.replace(/_/g, " ") : "";
}

function isField(element: Element): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function isSearchField(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  const hints = [
    field.getAttribute("type"),
    field.getAttribute("name"),
    field.getAttribute("placeholder"),
    field.getAttribute("aria-label"),
  ].join(" ");
  return /\b(search|find|filter)/i.test(hints) && !dialogOf(field);
}

function isTextField(element: Element): boolean {
  return isField(element) && !(element instanceof HTMLInputElement && element.type === "checkbox");
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  if (element.hidden || element.closest("[hidden], [aria-hidden=true]")) return false;
  const box = element.getClientRects()[0];
  // Acode keeps a few 1-2px helper fields (IME, title loading) that nobody can tap.
  return box !== undefined && (box.width >= 4 || box.height >= 4);
}

function dialogOf(element: Element): Element | null {
  return element.closest(".prompt");
}

function text(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_LABEL ? `${trimmed.slice(0, MAX_LABEL)}…` : trimmed;
}

function last<T extends Element>(list: ArrayLike<T>): T | undefined {
  return list.length ? list[list.length - 1] : undefined;
}
