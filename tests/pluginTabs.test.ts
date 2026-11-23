// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import plugin from "../plugin.json";
import { AgentController } from "../src/app/agentController";
import { SponsorBudget } from "../src/suggestions/session";
import { mountSidebar } from "../src/ui/sidebar/mountSidebar";

vi.mock("../src/app/agentController", () => ({ AgentController: vi.fn() }));
vi.mock("../src/ui/mount", () => ({ mountApp: vi.fn(), unmountApp: vi.fn() }));
vi.mock("../src/ui/sidebar/mountSidebar", () => ({
  mountSidebar: vi.fn(),
  unmountSidebar: vi.fn(),
}));
vi.mock("../src/platform/nativeHttp", () => ({
  initializeNativeHttp: vi.fn(),
  disposeNativeHttp: vi.fn(),
}));
vi.mock("../src/platform/hostMenus", () => ({ registerHostMenus: () => vi.fn() }));
vi.mock("../src/platform/pluginIcon", () => ({
  AGENT_ICON_CLASS: "agent",
  installPluginIcon: () => vi.fn(),
}));
vi.mock("../src/ui/workingPill", () => ({ installWorkingPill: () => vi.fn() }));
vi.mock("../src/ui/styles.css", () => ({ default: "" }));

afterEach(() => vi.unstubAllGlobals());

// Exercise the registered host APIs and callbacks without depending on registration order,
// generated tab IDs, or the plugin's private tab map.
async function setupPlugin() {
  vi.resetModules();
  const budget = new SponsorBudget();
  const state = { activeChatId: "owner", chats: [] };
  const controller = {
    sponsorBudget: budget,
    state,
    initialize: vi.fn(),
    selectChat: vi.fn(async (chatId: string) => {
      state.activeChatId = chatId;
    }),
    registerTool: vi.fn(),
    registerProvider: vi.fn(),
    registerContext: vi.fn(),
    registerFeature: vi.fn(),
    selectProvider: vi.fn(),
  };
  vi.mocked(AgentController).mockImplementation(function (this: AgentController) {
    return Object.assign(this, controller);
  });
  const files = new Map<string, EditorFile>();
  const manager = {
    activeFile: undefined as EditorFile | undefined,
    getFile: (id: string) => files.get(id),
  };
  class EditorFile {
    onclose?: () => void;
    onfocus?: () => void;
    constructor(
      _name: string,
      readonly options: { id: string },
    ) {
      files.set(options.id, this);
      manager.activeFile = this;
    }
    setCustomTitle() {}
    makeActive() {
      manager.activeFile = this;
      this.onfocus?.();
    }
    close() {
      files.delete(this.options.id);
      this.onclose?.();
    }
  }
  let initialize: Parameters<typeof acode.setPluginInit>[1] | undefined;
  let sidebarActions: Parameters<typeof mountSidebar>[2] | undefined;
  const modules = new Map<string, unknown>();
  vi.mocked(mountSidebar).mockImplementation((_root, _controller, actions) => {
    sidebarActions = actions;
  });
  const host = {
    require: (name: string) => {
      if (name === "EditorFile") return EditorFile;
      if (name === "sidebarApps")
        return {
          add: (_icon: string, _id: string, _title: string, mount: (root: HTMLElement) => void) =>
            mount(document.createElement("div")),
        };
    },
    addCommand: vi.fn(),
    define: (name: string, value: unknown) => modules.set(name, value),
    setPluginInit: (id: string, init: Parameters<typeof acode.setPluginInit>[1]) => {
      if (id === plugin.id) initialize = init;
    },
    setPluginUnmount: vi.fn(),
  };
  vi.stubGlobal("acode", host);
  vi.stubGlobal("editorManager", manager);
  await import("../src/main");
  const init = required(initialize, "plugin initializer");
  await init(
    "file:///plugin",
    document.createElement("wc-page") as Acode.WCPage,
    {
      ctx: null,
    } as Acode.PluginInitOptions,
  );
  const runtime = required(modules.get(`${plugin.id}.runtime`), "runtime API") as {
    open(chatId: string): void;
  };
  const actions = required(sidebarActions, "sidebar actions");
  return {
    budget,
    openChat(chatId: string) {
      runtime.open(chatId);
      return required(manager.activeFile, "active tab");
    },
    async openChatInNewTab(chatId: string) {
      await actions.onOpenSessionInNewTab(chatId);
      return required(manager.activeFile, "active tab");
    },
  };
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Host did not receive ${name}`);
  return value;
}

test("only closing the last tab bound to the offer's chat releases ownership", async () => {
  const { budget, openChat, openChatInNewTab } = await setupPlugin();
  const main = openChat("owner");
  budget.offerOptIn("owner");
  const duplicate = await openChatInNewTab("owner");
  const other = await openChatInNewTab("other");
  main.makeActive();
  other.makeActive();
  expect(budget.optInChatId).toBe("owner");
  other.close();
  expect(budget.optInChatId).toBe("owner");
  main.close();
  expect(budget.optInChatId).toBe("owner");
  duplicate.close();
  expect(budget.optInChatId).toBeUndefined();
  budget.offerOptIn("next");
  expect(budget.optInChatId).toBe("next");
});
