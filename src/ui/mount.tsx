import { render } from "preact";
import type { AgentController } from "../app/agentController";
import { App } from "./App";

export function mountApp(container: HTMLElement, controller: AgentController): void {
	render(<App controller={controller} />, container);
}

export function unmountApp(container: HTMLElement): void {
	render(null, container);
}
