import { ChevronLeft, ChevronRight } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { PromptVersions } from "./sessionTree";
import { CopyButton } from "./CopyButton";
import { formatMessageDateTime, formatMessageTime } from "./transcript";

/**
 * Time and copy row under a message. Copy shows on hover with a mouse and stays visible on
 * touch screens; tapping the time switches to the full date, since touch has no tooltips.
 */
export function MessageMeta({
  timestamp,
  detail,
  copyText,
  copyLabel,
  actions,
  align = "start",
}: {
  timestamp?: number;
  detail?: string;
  copyText?: string;
  copyLabel?: string;
  /** Buttons after copy, such as edit, retry, and fork. */
  actions?: ComponentChildren;
  align?: "start" | "end";
}) {
  const [full, setFull] = useState(false);
  const short = formatMessageTime(timestamp);
  const long = formatMessageDateTime(timestamp);
  const text = copyText?.trim();
  if (!short && !text) return null;
  return (
    <div class={`message-meta ${align}`}>
      {text && <CopyButton getText={() => text} label={copyLabel} />}
      {actions}
      {short && (
        <button
          type="button"
          class="message-time"
          title={long}
          aria-label={full ? long : `${short}, show full date`}
          onClick={() => setFull((value) => !value)}
        >
          <time dateTime={new Date(timestamp!).toISOString()}>{full ? long : short}</time>
          {detail && <span class="message-detail"> · {detail}</span>}
        </button>
      )}
    </div>
  );
}

/** An icon button in a message's meta row, styled like copy. */
export function MessageAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      class="copy-btn message-action"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** `‹ 2/3 ›`: flip between versions of an edited or retried prompt. */
export function VersionSwitcher({
  versions,
  disabled,
  onSwitch,
}: {
  versions: PromptVersions;
  disabled?: boolean;
  onSwitch: (index: number) => void;
}) {
  const { index, targets } = versions;
  return (
    <span class="version-switcher" aria-label={`Version ${index + 1} of ${targets.length}`}>
      <button
        type="button"
        aria-label="Previous version"
        disabled={disabled || index === 0}
        onClick={() => onSwitch(index - 1)}
      >
        <ChevronLeft size={14} strokeWidth={2} />
      </button>
      <span class="version-count">
        {index + 1}/{targets.length}
      </span>
      <button
        type="button"
        aria-label="Next version"
        disabled={disabled || index === targets.length - 1}
        onClick={() => onSwitch(index + 1)}
      >
        <ChevronRight size={14} strokeWidth={2} />
      </button>
    </span>
  );
}
