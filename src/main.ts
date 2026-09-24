import plugin from "../plugin.json";
import { buildComposerRequest, type ActionSubject, type ComposerRequest } from "./app/agentActions";
import { AgentController } from "./app/agentController";
import { Mailbox } from "./core/events";
import { getCodeHighlight } from "./platform/codeHighlight";
import {
  captureEditor,
  pickEditorAction,
  registerHostMenus,
  type HostActionRequest,
} from "./platform/hostMenus";
import { createHomeProject } from "./platform/randomProject";
import { installNativeFetch, uninstallNativeFetch } from "./platform/nativeHttp";
import { setPluginBaseUrl } from "./platform/pluginAssets";
import { PROVIDERS } from "./providers/providerRegistry";
import { mountApp, unmountApp } from "./ui/mount";
import { mountSidebar, unmountSidebar } from "./ui/sidebar/mountSidebar";
import styles from "./ui/styles.css";
import { PathSandbox } from "./workspace/pathSandbox";

const OPEN_COMMAND = `${plugin.id}:open`;
const NEW_COMMAND = `${plugin.id}:new-chat`;
const RANDOM_PROJECT_COMMAND = `${plugin.id}:random-project`;
const EDITOR_ACTIONS_COMMAND = `${plugin.id}:editor-actions`;
const ADD_SELECTION_COMMAND = `${plugin.id}:add-selection`;
const COMMANDS = [
  OPEN_COMMAND,
  NEW_COMMAND,
  RANDOM_PROJECT_COMMAND,
  EDITOR_ACTIONS_COMMAND,
  ADD_SELECTION_COMMAND,
];
const TAB_ID = `${plugin.id}:tab`;
const SIDEBAR_ID = `${plugin.id}:sidebar`;

type AgentTab = {
  file: Acode.EditorFile;
  root: HTMLElement;
  binding: { chatId?: string };
  inbox: Mailbox<ComposerRequest>;
};

class AcodeAiAgentPlugin {
  #tabs = new Map<string, AgentTab>();
  #controller: AgentController | null = null;
  #sidebarContainer: HTMLElement | null = null;
  #sidebarApps: Acode.SidebarApps | null = null;
  #disposeHostMenus: (() => void) | null = null;

  async init(
    baseUrl: string,
    _$page: Acode.WCPage,
    options: Acode.PluginInitOptions,
  ): Promise<void> {
    installNativeFetch();
    setPluginBaseUrl(baseUrl);
    const controller = new AgentController(options.ctx);
    this.#controller = controller;
    this.#registerCommands();
    this.#exposeExtensionApi(controller);
    this.#registerSidebar(controller);
    this.#disposeHostMenus = registerHostMenus(plugin.id, (request) =>
      this.#runHostActionSafely(request),
    );

    try {
      await controller.initialize();
    } catch (error) {
      console.error("AI agent initialization failed", error);
      acode.pushNotification(plugin.name, error instanceof Error ? error.message : String(error), {
        type: "error",
      });
    }
  }

  async destroy(): Promise<void> {
    this.#disposeHostMenus?.();
    this.#disposeHostMenus = null;
    this.#removeSidebar();
    await this.#closeTabs();
    await this.#controller?.dispose();
    this.#controller = null;
    uninstallNativeFetch();
    for (const command of COMMANDS) acode.removeCommand(command);
  }

  open(chatId?: string): void {
    this.#openTab(TAB_ID, chatId ?? this.#controller?.state.activeChatId);
  }

  #openTab(tabId: string, chatId?: string): void {
    const controller = this.#controller;
    if (!controller) return;
    const mounted = this.#tabs.get(tabId);
    if (mounted) {
      if (chatId) mounted.binding.chatId = chatId;
      this.#setTabTitle(mounted);
      mounted.file.makeActive();
      return;
    }
    const existing = editorManager.getFile(tabId, "id");
    if (existing) {
      existing.makeActive();
      return;
    }

    const EditorFile = acode.require("EditorFile");
    if (!EditorFile) {
      acode.pushNotification(plugin.name, "EditorFile is required to open the agent tab.", {
        type: "error",
      });
      return;
    }

    const root = document.createElement("div");
    root.className = "acode-agent-root";
    const fileOptions: Acode.FileOptions = {
      id: tabId,
      render: true,
      type: "page",
      content: root,
      tabIcon: "icon brain",
      hideQuickTools: true,
      stylesheets: [styles],
    };
    if (getCodeHighlight()) {
      Object.assign(fileOptions, { highlightStyles: true });
    }
    const file = new EditorFile(plugin.name, fileOptions);
    const record: AgentTab = { file, root, binding: { chatId }, inbox: new Mailbox() };
    this.#tabs.set(tabId, record);
    this.#setTabTitle(record);
    file.onfocus = () => {
      const targetId = record.binding.chatId;
      if (!targetId || controller.state.activeChatId === targetId) return;
      void controller.selectChat(targetId).catch((error) => {
        acode.pushNotification(
          plugin.name,
          error instanceof Error ? error.message : String(error),
          { type: "error" },
        );
      });
    };
    file.onclose = () => {
      unmountApp(root);
      this.#tabs.delete(tabId);
    };
    mountApp(
      root,
      controller,
      (activeChatId) => {
        if (editorManager.activeFile !== file) return;
        record.binding.chatId = activeChatId;
        this.#setTabTitle(record);
      },
      record.inbox,
    );
  }

  #runHostActionSafely(request: HostActionRequest): void {
    void this.#runHostAction(request).catch((error) => {
      acode.pushNotification(plugin.name, error instanceof Error ? error.message : String(error), {
        type: "error",
      });
    });
  }

  async #runHostAction({ action, source }: HostActionRequest): Promise<void> {
    const controller = this.#controller;
    if (!controller) throw new Error("The AI Agent is still starting.");
    const subject: ActionSubject =
      source.kind === "terminal"
        ? source
        : { ...source, path: await this.#enterWorkspaceOf(controller, source.uri) };
    if (!controller.state.workspace) throw new Error("Open a project folder to use the AI Agent.");
    const request = buildComposerRequest(action, subject);
    // Prefer a tab already showing the active chat so the request lands where the user expects.
    const chatId = controller.state.activeChatId;
    const tabId =
      [...this.#tabs.entries()].find(([, record]) => record.binding.chatId === chatId)?.[0] ??
      TAB_ID;
    this.#openTab(tabId, chatId);
    const record = this.#tabs.get(tabId);
    if (!record) throw new Error("The AI Agent tab could not be opened.");
    record.inbox.post(request);
  }

  /** Switch to the workspace holding `uri`, preferring the active one; returns its relative path. */
  async #enterWorkspaceOf(
    controller: AgentController,
    uri: string | undefined,
  ): Promise<string | undefined> {
    if (!uri) return undefined;
    const active = controller.state.workspace;
    const candidates = active
      ? [active, ...controller.workspaces.filter((workspace) => workspace.id !== active.id)]
      : controller.workspaces;
    for (const workspace of candidates) {
      const path = new PathSandbox(workspace.rootUri, acode.joinUrl).relative(uri);
      if (!path) continue;
      if (workspace.id !== active?.id) await controller.selectWorkspace(workspace.id);
      return path;
    }
    return undefined;
  }

  async selectProvider(providerId: string): Promise<void> {
    this.open();
    await this.#controller?.selectProvider(providerId);
  }

  #setTabTitle(record: AgentTab): void {
    record.file.setCustomTitle(() => {
      const chat = this.#controller?.state.chats.find((item) => item.id === record.binding.chatId);
      return chat?.title || "AI Agent";
    });
  }

  async #closeTabs(): Promise<void> {
    const tabs = [...this.#tabs.values()];
    this.#tabs.clear();
    await Promise.all(
      tabs.map(async ({ file, root }) => {
        file.onclose = undefined;
        unmountApp(root);
        await file.remove(true, { ignorePinned: true, silentPinned: true });
      }),
    );
  }

  #registerCommands(): void {
    acode.addCommand({
      name: OPEN_COMMAND,
      description: "AI Agent: Open",
      exec: () => {
        this.open();
        return true;
      },
    });
    acode.addCommand({
      name: NEW_COMMAND,
      description: "AI Agent: New conversation",
      exec: () => {
        this.open();
        void this.#controller?.newConversation();
        return true;
      },
    });
    acode.addCommand({
      name: EDITOR_ACTIONS_COMMAND,
      description: "AI Agent: Ask about selection or file",
      exec: () => {
        void pickEditorAction((request) => this.#runHostActionSafely(request));
        return true;
      },
    });
    acode.addCommand({
      name: ADD_SELECTION_COMMAND,
      description: "AI Agent: Add selection to chat",
      exec: () => {
        const source = captureEditor();
        if (source) this.#runHostActionSafely({ action: "add", source });
        return true;
      },
    });
    acode.addCommand({
      name: RANDOM_PROJECT_COMMAND,
      description: "AI Agent: New Random project",
      exec: () => {
        void this.#createRandomProject().catch((error) => {
          acode.pushNotification(
            plugin.name,
            error instanceof Error ? error.message : String(error),
            { type: "error" },
          );
        });
        return true;
      },
    });
  }

  #registerSidebar(controller: AgentController): void {
    const sidebarApps = acode.require("sidebarApps");
    if (!sidebarApps) {
      console.warn(
        "Acode sidebar apps API is unavailable; the Agent editor tab will remain available.",
      );
      return;
    }
    this.#sidebarApps = sidebarApps;
    sidebarApps.add(
      "icon brain",
      SIDEBAR_ID,
      "AI Agent",
      (container) => {
        this.#sidebarContainer = container;
        mountSidebar(container, controller, {
          onOpenAgent: () => this.open(),
          onOpenSession: async (chatId) => {
            this.open(chatId);
            await controller.selectChat(chatId);
          },
          onOpenSessionInNewTab: async (chatId) => {
            this.#openTab(`${TAB_ID}:${chatId}`, chatId);
            await controller.selectChat(chatId);
          },
          onNewSession: async (workspaceId) => {
            this.open();
            await controller.newConversation(workspaceId);
          },
          onCreateProject: () => this.#createRandomProject(),
          onDeleteSession: (chatId) => this.#deleteSession(chatId),
        });
      },
      false,
      () => {
        void controller.refreshWorkspaces();
      },
    );
  }

  #removeSidebar(): void {
    if (this.#sidebarContainer) unmountSidebar(this.#sidebarContainer);
    this.#sidebarContainer = null;
    this.#sidebarApps?.remove(SIDEBAR_ID);
    this.#sidebarApps = null;
  }

  async #createRandomProject() {
    const controller = this.#controller;
    if (!controller) throw new Error("The AI Agent is still starting.");
    const workspace = await createHomeProject();
    this.open();
    await controller.selectWorkspace(workspace.id);
    return workspace;
  }

  async #deleteSession(chatId: string): Promise<void> {
    const dedicated = [...this.#tabs.entries()].filter(
      ([tabId, record]) => tabId !== TAB_ID && record.binding.chatId === chatId,
    );
    await Promise.all(
      dedicated.map(async ([tabId, { file, root }]) => {
        this.#tabs.delete(tabId);
        file.onclose = undefined;
        unmountApp(root);
        await file.remove(true, { ignorePinned: true, silentPinned: true });
      }),
    );
    await this.#controller?.deleteChat(chatId);
  }

  #exposeExtensionApi(controller: AgentController): void {
    acode.define(
      `${plugin.id}.runtime`,
      Object.freeze({
        version: 1,
        registerTool: controller.registerTool.bind(controller),
        registerProvider: controller.registerProvider.bind(controller),
        registerContext: controller.registerContext.bind(controller),
        registerFeature: controller.registerFeature.bind(controller),
        selectProvider: controller.selectProvider.bind(controller),
        open: this.open.bind(this),
      }),
    );
  }
}

const instance = new AcodeAiAgentPlugin();

const pluginSettings: Acode.PluginSettings = {
  list: [
    {
      key: "open",
      text: "Open AI Agent",
      icon: "brain",
      info: "Opens as an editor tab. Configure provider credentials securely inside the agent.",
    },
    {
      key: "provider",
      text: "Default provider",
      select: PROVIDERS.map((provider) => provider.id),
      value: "openrouter",
    },
  ],
  cb: (key, value) => {
    if (key === "open") instance.open();
    if (key === "provider") {
      void instance.selectProvider(String(value)).catch((error) => {
        acode.pushNotification(plugin.name, String(error), { type: "error" });
      });
    }
  },
};

if (window.acode) {
  acode.setPluginInit(
    plugin.id,
    async (baseUrl, $page, options) => instance.init(baseUrl, $page, options),
    pluginSettings,
  );
  acode.setPluginUnmount(plugin.id, () => {
    void instance.destroy();
  });
}
