// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PublicAgentState } from "../src/core/types";
import {
  acodeUiApproval,
  closablePageCount,
  coveringLayer,
  createAcodeUiTool,
} from "../src/tools/acodeUi";
import { installWorkingPill } from "../src/ui/workingPill";
import { runTool } from "./toolHarness";

// happy-dom has no layout, so give every element a box; `hidden` still hides.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList,
  );
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const tool = createAcodeUiTool();
const snapshot = async () => {
  const output = await runTool(tool, { action: "snapshot" });
  return output.content.map((part) => part.text ?? "").join("");
};

function page(title: string, body: string): HTMLElement {
  const element = document.createElement("wc-page");
  element.setAttribute("data-title", title);
  element.innerHTML =
    `<header><span class="icon arrow_back" action="go-back"></span><span class="text">${title}</span></header>` +
    body;
  document.body.append(element);
  return element;
}

/** Acode's plugins page: tabs with their own handlers, a delegating page, and plugin rows. */
function pluginsPage() {
  const element = page(
    "Plugins",
    `<span class="icon search" data-action="search"></span>
     <div id="plugins">
       <div class="options">
         <span id="installed_plugins" tabindex="0" class="active">Installed</span>
         <span id="all_plugins" tabindex="0">All</span>
         <span id="owned_plugins" tabindex="0">Owned</span>
         <div class="tab-indicator"></div>
       </div>
       <div class="list scroll" tabindex="0">
         <div data-id="acode.ai.agent" class="list-item" data-action="open">
           <div class="plugin-header">
             <span class="plugin-name">Acode AI Agent</span><span class="plugin-version">v0.3.0</span>
             <span class="plugin-toggle-switch" data-enabled="true"><span class="plugin-toggle-track"></span></span>
           </div>
         </div>
       </div>
     </div>`,
  );
  const onTab = { all: vi.fn() };
  element.onclick = () => {};
  element.querySelector<HTMLElement>("#all_plugins")!.onclick = onTab.all;
  for (const id of ["installed_plugins", "owned_plugins"])
    element.querySelector<HTMLElement>(`#${id}`)!.onclick = () => {};
  const toggle = vi.fn();
  element.querySelector<HTMLElement>(".plugin-toggle-switch")!.onclick = toggle;
  return { onTab, toggle };
}

test("lists the plugins page's tabs, rows and row switches, not the containers that delegate clicks", async () => {
  pluginsPage();

  expect(await snapshot()).toBe(
    [
      "Screen: page — Plugins",
      '[1] button "arrow back" (go-back)',
      '[2] button "search" (search)',
      '[3] tab "Installed" (selected)',
      '[4] tab "All"',
      '[5] tab "Owned"',
      '[6] item "Acode AI Agent" (acode.ai.agent)',
      '[7] toggle "Acode AI Agent switch" on',
    ].join("\n"),
  );
});

test("switching tabs and opening a plugin are free; its switch follows the permission mode", async () => {
  const { onTab } = pluginsPage();
  await snapshot();

  expect(acodeUiApproval({ action: "click", ref: 4 }).risk).toBeUndefined();
  expect(acodeUiApproval({ action: "click", ref: 6 }).risk).toBeUndefined();
  expect(acodeUiApproval({ action: "click", ref: 7 }).risk).toBe("change");

  const output = await runTool(tool, { action: "click", ref: 4 });
  expect(onTab.all).toHaveBeenCalledOnce();
  expect(output.content[0]?.text).toContain('Tapped "All".');
});

test("tabs a tab bar handles for its children are listed and reach the bar's handler", async () => {
  const element = page(
    "Acode AI Agent",
    `<div class="options">
       <span class="tab active" data-tab="overview" tabindex="0">Overview</span>
       <span class="tab" data-tab="changelog" tabindex="0">Changelog</span>
     </div>
     <button class="btn btn-uninstall">Uninstall</button>
     <button data-type="buy" class="btn btn-install">₹99</button>`,
  );
  const onBar = vi.fn((event: Event) => (event.target as HTMLElement).dataset.tab);
  element.querySelector<HTMLElement>(".options")!.onclick = onBar;

  expect(await snapshot()).toContain(
    [
      '[2] tab "Overview" (selected) (overview)',
      '[3] tab "Changelog" (changelog)',
      '[4] button "Uninstall"',
      '[5] button "₹99" (buy)',
    ].join("\n"),
  );
  expect(acodeUiApproval({ action: "click", ref: 4 }).risk).toBe("risky");
  await expect(runTool(tool, { action: "click", ref: 5 })).rejects.toThrow("purchases, ads");

  await runTool(tool, { action: "click", ref: 3 });
  expect(onBar).toHaveReturnedWith("changelog");
});

test("marks the current theme and refuses paid ones", async () => {
  page(
    "Theme",
    `<div class="list">
       <div class="list-item" checked="true"><div class="container"><span class="text">Dark</span></div><span class="icon check"></span></div>
       <div class="list-item"><div class="container"><span class="text">Ocean</span></div><span class="icon stars"></span></div>
     </div>`,
  );
  for (const row of document.querySelectorAll<HTMLElement>(".list-item")) row.onclick = () => {};

  expect(await snapshot()).toContain(
    ['[2] item "Dark" (selected)', '[3] item "Ocean" (paid)'].join("\n"),
  );
  await expect(runTool(tool, { action: "click", ref: 3 })).rejects.toThrow("purchases, ads");
});

test("reads a prompt dialog: its form's action is HTML's, and its question names the field", async () => {
  const dialog = document.createElement("form");
  dialog.className = "prompt";
  dialog.setAttribute("action", "#");
  dialog.innerHTML = `<span class="message scroll">Font size</span><input class="input" type="text" value="12px">
    <div class="button-container"><button type="button">Cancel</button><button type="submit">ok</button></div>`;
  document.body.append(dialog);

  expect(await snapshot()).toBe(
    [
      "Screen: dialog — Font size",
      '[1] input "Font size" = "12px"',
      '[2] button "Cancel"',
      '[3] button "ok"',
    ].join("\n"),
  );
  expect(acodeUiApproval({ action: "click", ref: 2 }).risk).toBeUndefined();
  expect(acodeUiApproval({ action: "click", ref: 3 }).risk).toBe("risky");
});

test("shows stored setting values, store prices and ads, and skips headers, prose lists and tiny helpers", async () => {
  vi.stubGlobal("acode", { require: () => ({ value: { fontSize: "12px" } }) });
  const element = page(
    "Settings",
    `<div class="list-item" data-key="fontSize"><div class="container"><div class="text">Font size</div>
       <small class="value">Set the editor text size.</small></div></div>
     <div class="list-item" data-key="promo-https%3A%2F%2Fgo.acode.app%2Fp%2F1"><div class="container"><div class="text">Shellular</div></div></div>
     <div class="list-item" data-id="dev.pixforge" data-action="open"><span class="plugin-name">Pixforge</span><span class="plugin-price">₹49.00</span></div>
     <ul class="md"><li>Tap the GitHub icon.</li></ul>
     <textarea class="tiny"></textarea>`,
  );
  element.querySelector("header")!.classList.add("tile");
  const tiny = element.querySelector(".tiny")!;
  vi.mocked(HTMLElement.prototype.getClientRects).mockImplementation(function (this: HTMLElement) {
    const size = this === tiny ? 1.6 : 10;
    return [new DOMRect(0, 0, size, size)] as unknown as DOMRectList;
  });

  expect(await snapshot()).toBe(
    [
      "Screen: page — Settings",
      '[1] button "arrow back" (go-back)',
      '[2] setting "Font size" = "12px" (fontSize) → opens',
      '[3] setting "Shellular" (ad) → opens',
      '[4] item "Pixforge" = "₹49.00" (dev.pixforge)',
    ].join("\n"),
  );
  await expect(runTool(tool, { action: "click", ref: 3 })).rejects.toThrow("purchases, ads");
  vi.unstubAllGlobals();
});

/** Acode's phone sidebar on the Plugins app, as it overlays the editor. */
function phoneSidebar(): HTMLElement {
  const sidebar = document.createElement("div");
  sidebar.id = "sidebar";
  sidebar.className = "phone show";
  sidebar.innerHTML = `<div class="apps"><div class="app-icons-container">
      <span title="Files" data-action="sidebar-app" data-id="files" class="icon documents"></span>
      <span title="Plugins" data-action="sidebar-app" data-id="extensions" class="icon extension active"></span>
      <span title="Sponsor" class="icon favorite"></span>
    </div></div>
    <div class="container extensions"><div class="header"><input placeholder="Search" name="search-ext" type="search"></div></div>`;
  sidebar.querySelector<HTMLElement>(".favorite")!.onclick = () => {};
  document.body.append(sidebar);
  return sidebar;
}

test("snapshots the phone sidebar as its own layer, with a search box and sponsor refused", async () => {
  phoneSidebar();
  expect(coveringLayer()).toBe("sidebar");
  expect(closablePageCount()).toBe(1);

  expect(await snapshot()).toBe(
    [
      "Screen: sidebar — Sidebar, Plugins app",
      '[1] button "Files" (files)',
      '[2] button "Plugins" (selected) (extensions)',
      '[3] button "Sponsor"',
      '[4] input "Search" = "" (search box)',
    ].join("\n"),
  );
  expect(acodeUiApproval({ action: "type", ref: 4, text: "python" }).risk).toBe("change");
  expect(acodeUiApproval({ action: "click", ref: 2 }).risk).toBeUndefined();
  await expect(runTool(tool, { action: "click", ref: 3 })).rejects.toThrow("purchases, ads");
});

test("the working pill shows when the sidebar covers the agent tab, and answers approvals in place", async () => {
  const listeners = new Set<() => void>();
  const state = {
    status: "running",
    activities: [],
    approval: undefined,
  } as unknown as PublicAgentState;
  vi.stubGlobal("editorManager", { on: () => {}, off: () => {} });
  const approve = vi.fn();
  const dispose = installWorkingPill({
    state: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    approve,
    agentTabActive: () => true,
    openChat: () => {},
  });
  const pill = document.querySelector<HTMLElement>(".acode-agent-pill")!;
  expect(pill.hidden).toBe(true);

  phoneSidebar();
  await new Promise((resolve) => setTimeout(resolve));
  expect(pill.hidden).toBe(false);
  expect(pill.textContent).toContain("AI Agent is working");

  state.approval = {
    id: "1",
    toolName: "acode_ui",
    path: ".",
    title: "Tap in Acode: OK",
    preview: "",
    once: true,
    resolve: () => {},
  };
  for (const listener of listeners) listener();
  expect(pill.textContent).toContain("AI Agent needs approval: Tap in Acode: OK");
  expect(pill.textContent).not.toContain("Allow this session");
  [...pill.querySelectorAll("button")]
    .find((button) => button.textContent === "Allow once")!
    .click();
  expect(approve).toHaveBeenCalledWith("allow");

  dispose();
  vi.unstubAllGlobals();
});
