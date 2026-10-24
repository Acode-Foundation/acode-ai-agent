import type { MutationDecision, PublicAgentState } from "../core/types";
import { coveringLayer } from "../tools/acodeUi";

type PillHost = {
  state: () => PublicAgentState;
  subscribe: (listener: () => void) => () => void;
  approve: (decision: MutationDecision) => void;
  /** Whether an agent tab is the active editor tab. */
  agentTabActive: () => boolean;
  openChat: () => void;
};

const STYLE_ID = "acode-agent-pill-style";
const CSS = `
.acode-agent-pill{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 72px);transform:translateX(-50%);
z-index:2147483000;max-width:min(92vw,420px);display:flex;flex-direction:column;gap:8px;padding:8px 14px;border-radius:18px;
background:var(--popup-background-color,#222);color:var(--popup-text-color,#eee);border:1px solid var(--border-color,#444);
box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.35}
.acode-agent-pill[hidden]{display:none}
.acode-agent-pill-row{display:flex;align-items:center;gap:8px;cursor:pointer}
.acode-agent-pill-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--active-color,#3b82f6);animation:acode-agent-pulse 1.2s ease-in-out infinite}
.acode-agent-pill.waiting .acode-agent-pill-dot{background:#f59e0b;animation:none}
.acode-agent-pill-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acode-agent-pill-preview{margin:0;max-height:96px;overflow:auto;white-space:pre-wrap;font:inherit;opacity:.85}
.acode-agent-pill-actions{display:flex;justify-content:flex-end;gap:8px}
.acode-agent-pill-actions button{border:1px solid var(--border-color,#555);background:transparent;color:inherit;border-radius:12px;padding:4px 12px;font:inherit}
.acode-agent-pill-actions button.primary{background:var(--button-background-color,#3b82f6);color:var(--button-text-color,#fff);border-color:transparent}
[data-acode-agent-target]{outline:2px solid #f59e0b !important;outline-offset:2px}
@keyframes acode-agent-pulse{50%{opacity:.35}}
`;

/**
 * A small floating pill over Acode while the agent works and its chat is out of sight: it says what
 * the agent is doing, lets the user answer an approval in place, and taps through to the chat.
 */
export function installWorkingPill(host: PillHost): () => void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }
  const pill = document.createElement("div");
  pill.className = "acode-agent-pill";
  pill.setAttribute("role", "status");
  pill.hidden = true;
  document.body.append(pill);

  let rendered = "";
  const render = () => {
    const state = host.state();
    const busy = state.status === "running" || state.approval || state.questionnaire;
    const hidden = !busy || (host.agentTabActive() && !coveringLayer());
    pill.hidden = hidden;
    if (hidden) {
      rendered = "";
      return;
    }
    const approval = state.approval;
    const key = approval
      ? `approval:${approval.id}`
      : state.questionnaire
        ? "question"
        : `working:${currentTool(state) ?? ""}`;
    if (key === rendered) return;
    rendered = key;
    pill.classList.toggle("waiting", Boolean(approval || state.questionnaire));
    pill.replaceChildren();
    const row = document.createElement("div");
    row.className = "acode-agent-pill-row";
    row.onclick = () => host.openChat();
    const dot = document.createElement("span");
    dot.className = "acode-agent-pill-dot";
    const label = document.createElement("span");
    label.className = "acode-agent-pill-text";
    label.textContent = approval
      ? `AI Agent needs approval: ${approval.title}`
      : state.questionnaire
        ? "AI Agent has a question. Tap to answer"
        : `AI Agent is working${currentTool(state) ? ` · ${currentTool(state)}` : "…"}`;
    row.append(dot, label);
    pill.append(row);
    if (!approval) return;
    const preview = document.createElement("pre");
    preview.className = "acode-agent-pill-preview";
    preview.textContent = approval.preview;
    const actions = document.createElement("div");
    actions.className = "acode-agent-pill-actions";
    actions.append(
      button("Deny", () => host.approve("deny")),
      ...(approval.once ? [] : [button("Allow this session", () => host.approve("allow-session"))]),
      button("Allow once", () => host.approve("allow"), true),
    );
    pill.append(preview, actions);
  };

  const unsubscribe = host.subscribe(render);
  const onSwitch = () => render();
  editorManager.on("switch-file", onSwitch);
  // Pages, menus and dialogs are added to and removed from the body.
  const observer = new MutationObserver(() => render());
  observer.observe(document.body, { childList: true });
  render();

  return () => {
    unsubscribe();
    editorManager.off("switch-file", onSwitch);
    observer.disconnect();
    pill.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}

function currentTool(state: PublicAgentState): string | undefined {
  for (let index = state.activities.length - 1; index >= 0; index--) {
    const activity = state.activities[index]!;
    if (activity.status === "running") return activity.name;
  }
  return undefined;
}

function button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  if (primary) element.className = "primary";
  element.onclick = (event) => {
    event.stopPropagation();
    onClick();
  };
  return element;
}
