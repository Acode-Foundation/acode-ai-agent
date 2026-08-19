import plugin from "../plugin.json";
import { AgentController } from "./app/agentController";
import { getCodeHighlight } from "./platform/codeHighlight";
import { installNativeFetch } from "./platform/nativeHttp";
import { PROVIDERS } from "./providers/providerRegistry";
import { mountApp, unmountApp } from "./ui/mount";
import styles from "./ui/styles.css";

const OPEN_COMMAND = `${plugin.id}:open`;
const NEW_COMMAND = `${plugin.id}:new-chat`;
const TAB_ID = `${plugin.id}:tab`;

class AcodeAiAgentPlugin {
	#file: Acode.EditorFile | null = null;
	#root: HTMLElement | null = null;
	#controller: AgentController | null = null;
	#pauseHandler = () => this.#controller?.abort();

	async init(_baseUrl: string, _$page: Acode.WCPage, options: Acode.PluginInitOptions): Promise<void> {
		installNativeFetch();
		const controller = new AgentController(options.ctx);
		this.#controller = controller;
		this.#registerCommands();
		this.#exposeExtensionApi(controller);
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
		await this.#closeTab();
		await this.#controller?.dispose();
		this.#controller = null;
		acode.removeCommand(OPEN_COMMAND);
		acode.removeCommand(NEW_COMMAND);
	}

	open(): void {
		const existing = editorManager.getFile(TAB_ID, "id");
		if (existing) {
			this.#file = existing;
			existing.makeActive();
			return;
		}

		const controller = this.#controller;
		if (!controller) return;

		const EditorFile = acode.require("EditorFile");
		if (!EditorFile) {
			acode.pushNotification(plugin.name, "EditorFile is required to open the agent tab.", { type: "error" });
			return;
		}

		const root = document.createElement("div");
		root.className = "acode-agent-root";
		const fileOptions: Acode.FileOptions = {
			id: TAB_ID,
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
		file.setCustomTitle(() => "In-process coding agent");
		file.onclose = () => {
			this.#unmount();
			this.#file = null;
		};
		this.#file = file;
		this.#root = root;
		mountApp(root, controller);
	}

	async selectProvider(providerId: string): Promise<void> {
		this.open();
		await this.#controller?.selectProvider(providerId);
	}

	#unmount(): void {
		if (!this.#root) return;
		unmountApp(this.#root);
		this.#root = null;
	}

	async #closeTab(): Promise<void> {
		const file = this.#file ?? editorManager.getFile(TAB_ID, "id") ?? null;
		this.#unmount();
		this.#file = null;
		if (file) await file.remove(true, { ignorePinned: true, silentPinned: true });
	}

	#registerCommands(): void {
		acode.addCommand({ name: OPEN_COMMAND, description: "AI Agent: Open", exec: () => { this.open(); return true; } });
		acode.addCommand({ name: NEW_COMMAND, description: "AI Agent: New conversation", exec: () => { this.open(); void this.#controller?.newConversation(); return true; } });
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
