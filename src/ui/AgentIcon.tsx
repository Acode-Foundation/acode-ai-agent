import { AGENT_ICON_MASK } from "../platform/pluginIcon";

export function AgentIcon({ size = 18 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        flex: "none",
        width: size,
        height: size,
        background: "currentColor",
        mask: AGENT_ICON_MASK,
        WebkitMask: AGENT_ICON_MASK,
      }}
    />
  );
}
