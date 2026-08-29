import { render } from "preact";
import type { AgentController } from "../../app/agentController";
import type { WorkspaceInfo } from "../../core/types";
import sidebarStyles from "./sidebar.css";
import { SidebarApp } from "./SidebarApp";

type SidebarActions = {
	onOpenAgent(): void;
	onOpenSession(chatId: string): Promise<void>;
	onOpenSessionInNewTab(chatId: string): Promise<void>;
	onNewSession(workspaceId: string): Promise<void>;
	onDeleteSession(chatId: string): Promise<void>;
	onCreateProject(): Promise<WorkspaceInfo>;
};

export function mountSidebar(container: HTMLElement, controller: AgentController, actions: SidebarActions): void {
	container.replaceChildren();
	const style = document.createElement("style");
	style.dataset.acodeAgentSidebar = "true";
	style.textContent = sidebarStyles;
	const root = document.createElement("div");
	root.className = "acode-agent-sidebar-host";
	container.append(style, root);
	render(<SidebarApp controller={controller} {...actions} />, root);
}

export function unmountSidebar(container: HTMLElement): void {
	const root = container.querySelector<HTMLElement>(".acode-agent-sidebar-host");
	if (root) render(null, root);
	container.replaceChildren();
}
