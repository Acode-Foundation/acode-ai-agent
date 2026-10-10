import icon from "../../icon.svg";

export const AGENT_ICON_CLASS = "acode-ai-agent-icon";
export const AGENT_ICON_MASK = `url("data:image/svg+xml,${encodeURIComponent(icon)}") center / contain no-repeat`;

export function installPluginIcon(): () => void {
  const style = document.createElement("style");
  style.textContent = `.icon.${AGENT_ICON_CLASS}::before {
    content: "";
    display: inline-block;
    width: 1em;
    height: 1em;
    background: currentColor;
    -webkit-mask: ${AGENT_ICON_MASK};
    mask: ${AGENT_ICON_MASK};
    vertical-align: middle;
  }`;
  document.head.append(style);
  return () => style.remove();
}
