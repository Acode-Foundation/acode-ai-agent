import plugin from "../plugin.json";
import { AgentController } from "./app/agentController";
import { getCodeHighlight } from "./platform/codeHighlight";
import { createHomeProject } from "./platform/randomProject";
import { installNativeFetch } from "./platform/nativeHttp";
import { setPluginBaseUrl } from "./platform/pluginAssets";
import { PROVIDERS } from "./providers/providerRegistry";
import { mountApp, unmountApp } from "./ui/mount";
import { mountSidebar, unmountSidebar } from "./ui/sidebar/mountSidebar";
import styles from "./ui/styles.css";

const OPEN_COMMAND = `${plugin.id}:open`;
const NEW_COMMAND = `${plugin.id}:new-chat`;
const RANDOM_PROJECT_COMMAND = `${plugin.id}:random-project`;
const TAB_ID = `${plugin.id}:tab`;
const SIDEBAR_ID = `${plugin.id}:sidebar`;

type AgentTab = {
	file: Acode.EditorFile;
	root: HTMLElement;
	binding: { chatId?: string };
};

class AcodeAiAgentPlugin {
	#tabs = new Map<string, AgentTab>();
	#controller: AgentController | null = null;
	#sidebarContainer: HTMLElement | null = null;
	#sidebarApps: Acode.SidebarApps | null = null;
	#pauseHandler = () => this.#controller?.abort();

	async init(baseUrl: string, _$page: Acode.WCPage, options: Acode.PluginInitOptions): Promise<void> {
		installNativeFetch();
		setPluginBaseUrl(baseUrl);
		const controller = new AgentController(options.ctx);
		this.#controller = controller;
		this.#registerCommands();
		this.#exposeExtensionApi(controller);
		this.#registerSidebar(controller);
		document.addEventListener("pause", this.#pauseHandler);

		try {
			await controller.initialize();
		} catch (error) {
			console.error("AI agent initialization failed", error);
			acode.pushNotification(plugin.name, error instanceof Error ? error.message : String(error), { type: "error" });
		}
	}

	async destroy(): Promise<void> {
		document.removeEventListener("pause", this.#pauseHandler);
		this.#removeSidebar();
		await this.#closeTabs();
		await this.#controller?.dispose();
		this.#controller = null;
		acode.removeCommand(OPEN_COMMAND);
		acode.removeCommand(NEW_COMMAND);
		acode.removeCommand(RANDOM_PROJECT_COMMAND);
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
			acode.pushNotification(plugin.name, "EditorFile is required to open the agent tab.", { type: "error" });
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
		const record: AgentTab = { file, root, binding: { chatId } };
		this.#tabs.set(tabId, record);
		this.#setTabTitle(record);
		file.onfocus = () => {
			const targetId = record.binding.chatId;
			if (!targetId || controller.state.activeChatId === targetId) return;
			void controller.selectChat(targetId).catch((error) => {
				acode.pushNotification(plugin.name, error instanceof Error ? error.message : String(error), { type: "error" });
			});
		};
		file.onclose = () => {
			unmountApp(root);
			this.#tabs.delete(tabId);
		};
		mountApp(root, controller, (activeChatId) => {
			if (editorManager.activeFile !== file) return;
			record.binding.chatId = activeChatId;
			this.#setTabTitle(record);
		});
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
		await Promise.all(tabs.map(async ({ file, root }) => {
			file.onclose = undefined;
			unmountApp(root);
			await file.remove(true, { ignorePinned: true, silentPinned: true });
		}));
	}

	#registerCommands(): void {
		acode.addCommand({ name: OPEN_COMMAND, description: "AI Agent: Open", exec: () => { this.open(); return true; } });
		acode.addCommand({ name: NEW_COMMAND, description: "AI Agent: New conversation", exec: () => { this.open(); void this.#controller?.newConversation(); return true; } });
		acode.addCommand({
			name: RANDOM_PROJECT_COMMAND,
			description: "AI Agent: New Random project",
			exec: () => {
				void this.#createRandomProject().catch((error) => {
					acode.pushNotification(plugin.name, error instanceof Error ? error.message : String(error), { type: "error" });
				});
				return true;
			},
		});
	}

	#registerSidebar(controller: AgentController): void {
		const sidebarApps = acode.require("sidebarApps");
		if (!sidebarApps) {
			console.warn("Acode sidebar apps API is unavailable; the Agent editor tab will remain available.");
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
			() => { void controller.refreshWorkspaces(); },
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
		const dedicated = [...this.#tabs.entries()].filter(([tabId, record]) => tabId !== TAB_ID && record.binding.chatId === chatId);
		await Promise.all(dedicated.map(async ([tabId, { file, root }]) => {
			this.#tabs.delete(tabId);
			file.onclose = undefined;
			unmountApp(root);
			await file.remove(true, { ignorePinned: true, silentPinned: true });
		}));
		await this.#controller?.deleteChat(chatId);
	}

	#exposeExtensionApi(controller: AgentController): void {
		acode.define(`${plugin.id}.runtime`, Object.freeze({
			version: 1,
			registerTool: controller.registerTool.bind(controller),
			registerProvider: controller.registerProvider.bind(controller),
			registerContext: controller.registerContext.bind(controller),
			registerFeature: controller.registerFeature.bind(controller),
			selectProvider: controller.selectProvider.bind(controller),
			open: this.open.bind(this),
		}));
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
	acode.setPluginInit(plugin.id, async (baseUrl, $page, options) => instance.init(baseUrl, $page, options), pluginSettings);
	acode.setPluginUnmount(plugin.id, () => { void instance.destroy(); });
}
