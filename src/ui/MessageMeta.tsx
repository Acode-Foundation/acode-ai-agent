import { useState } from "preact/hooks";
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
  align = "start",
}: {
  timestamp?: number;
  detail?: string;
  copyText?: string;
  copyLabel?: string;
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
