import { ACTION_ICONS, actionsFor, type AgentActionId } from "../app/agentActions";

/** Editor text captured when a menu opens, before any dialog can move the selection. */
export type EditorCapture = {
  kind: "selection" | "file";
  uri?: string;
  name: string;
  text: string;
  startLine?: number;
  endLine?: number;
};

export type HostActionRequest = {
  action: AgentActionId;
  source: EditorCapture | { kind: "terminal"; text: string };
};

type CodeMirrorLike = {
  state?: {
    selection?: { main?: { from: number; to: number } };
    doc?: { lineAt?(pos: number): { number: number; from: number } };
  };
};

type SelectionMenuSlot = { open?: () => void };
type SelectionMenuAdd = (
  onclick: () => void,
  text: string | HTMLElement,
  mode: "selected" | "all",
  readOnly: boolean,
  options: { id: string; label: string },
) => void;

const MENU_TITLE = "AI Agent";

/**
 * Add the agent to the editor selection menu and the terminal selection "More" menu.
 * Missing host APIs (older Acode builds) are skipped.
 */
export function registerHostMenus(
  pluginId: string,
  onRequest: (request: HostActionRequest) => void,
): () => void {
  const disposers = [
    registerSelectionMenu(pluginId, () => void pickEditorAction(onRequest)),
    registerTerminalOptions(pluginId, onRequest),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Show the editor action picker for the active file, as the selection menu does. */
export async function pickEditorAction(
  onRequest: (request: HostActionRequest) => void,
): Promise<void> {
  const capture = captureEditor();
  if (!capture) return;
  // Let the tap that opened the picker finish first; Android WebView can deliver it to the first row.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const select = acode.require("select");
  const items = actionsFor(capture.kind).map(({ id, label }) => ({
    value: id,
    text: label,
    icon: ACTION_ICONS[id],
  }));
  const picked = await select(MENU_TITLE, items).catch(() => undefined);
  if (picked) onRequest({ action: picked as AgentActionId, source: capture });
}

export function captureEditor(): EditorCapture | undefined {
  const manager = window.editorManager;
  const file = manager?.activeFile;
  const editor = manager?.editor;
  if (!file || !editor || (file.type && file.type !== "editor")) return undefined;
  const name = file.filename || "untitled";
  const uri = file.uri || undefined;
  const selected = editor.getCopyText?.() ?? "";
  if (!selected.trim()) return { kind: "file", uri, name, text: editor.getValue?.() ?? "" };
  return {
    kind: "selection",
    uri,
    name,
    text: selected,
    ...selectedLines(editor as CodeMirrorLike),
  };
}

function selectedLines(editor: CodeMirrorLike): { startLine?: number; endLine?: number } {
  const range = editor.state?.selection?.main;
  const doc = editor.state?.doc;
  if (!range || typeof doc?.lineAt !== "function") return {};
  try {
    const start = doc.lineAt(range.from);
    const end = doc.lineAt(range.to);
    // A selection that ends at column 0 does not include that line.
    const endLine =
      range.to === end.from && end.number > start.number ? end.number - 1 : end.number;
    return { startLine: start.number, endLine };
  } catch {
    return {};
  }
}

function registerSelectionMenu(pluginId: string, open: () => void): () => void {
  const selectionMenu = acode.require("selectionMenu") as Acode.SelectionMenu | undefined;
  if (typeof selectionMenu?.add !== "function") return () => undefined;
  // Acode has no selectionMenu.remove, so the item outlives a plugin reload. Register it once per
  // page and point it at a slot the current plugin instance fills.
  const host = globalThis as unknown as Record<symbol, SelectionMenuSlot | undefined>;
  const key = Symbol.for(`${pluginId}:selection-menu`);
  const slot = host[key] ?? (host[key] = addSelectionMenuItem(selectionMenu, pluginId));
  slot.open = open;
  return () => {
    if (slot.open === open) slot.open = undefined;
  };
}

function addSelectionMenuItem(
  selectionMenu: Acode.SelectionMenu,
  pluginId: string,
): SelectionMenuSlot {
  const slot: SelectionMenuSlot = {};
  const icon = document.createElement("span");
  icon.className = "icon brain";
  icon.title = MENU_TITLE;
  icon.setAttribute("aria-label", MENU_TITLE);
  (selectionMenu.add as SelectionMenuAdd)(
    () => {
      if (slot.open) slot.open();
      else acode.require("toast")?.("AI Agent is not running.");
    },
    icon,
    "all",
    true,
    { id: pluginId, label: MENU_TITLE },
  );
  return slot;
}

function registerTerminalOptions(
  pluginId: string,
  onRequest: (request: HostActionRequest) => void,
): () => void {
  const moreOptions = (acode.require("terminal") as Acode.Terminal | undefined)?.moreOptions;
  if (typeof moreOptions?.add !== "function") return () => undefined;
  const ids = actionsFor("terminal").flatMap(({ id, label }) => {
    const registered = moreOptions.add({
      id: `${pluginId}:terminal-${id}`,
      label,
      icon: ACTION_ICONS[id],
      enabled: ({ selection }) => Boolean(selection?.trim()),
      action: ({ selection, clearSelection }) => {
        const text = selection?.trim();
        if (!text) return;
        (clearSelection as (() => void) | undefined)?.();
        onRequest({ action: id, source: { kind: "terminal", text } });
      },
    });
    return registered ? [registered] : [];
  });
  return () => {
    for (const id of ids) moreOptions.remove(id);
  };
}
