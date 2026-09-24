import { render } from "preact";
import type { AgentController } from "../app/agentController";
import type { ComposerRequest } from "../app/agentActions";
import type { Mailbox } from "../core/events";
import { App } from "./App";

export function mountApp(
  container: HTMLElement,
  controller: AgentController,
  onActiveChatChange?: (chatId: string) => void,
  inbox?: Mailbox<ComposerRequest>,
): void {
  render(
    <App controller={controller} onActiveChatChange={onActiveChatChange} inbox={inbox} />,
    container,
  );
}

export function unmountApp(container: HTMLElement): void {
  render(null, container);
}
