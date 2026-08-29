import { render } from "preact";
import type { AgentController } from "../app/agentController";
import { App } from "./App";

export function mountApp(container: HTMLElement, controller: AgentController, onActiveChatChange?: (chatId: string) => void): void {
	render(<App controller={controller} onActiveChatChange={onActiveChatChange} />, container);
}

export function unmountApp(container: HTMLElement): void {
	render(null, container);
}
