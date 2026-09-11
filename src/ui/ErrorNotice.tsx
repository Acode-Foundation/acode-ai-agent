import { CircleAlert, ChevronDown } from "lucide-preact";
import { useState } from "preact/hooks";
import { Collapse, RotateIcon } from "./Collapse";

export function ErrorNotice({
  message,
  title = "Request failed",
  action,
  secondaryAction,
}: {
  message: string;
  title?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const error = presentError(message);
  return (
    <div class="error-notice" role="alert">
      <div class="error-notice-main">
        <CircleAlert size={15} strokeWidth={2} aria-hidden="true" />
        <div>
          <strong>{title}</strong>
          <p>{error.summary}</p>
        </div>
      </div>
      {error.details && (
        <>
          <button
            type="button"
            class="error-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            <span>{detailsOpen ? "Hide details" : "Show details"}</span>
            <RotateIcon open={detailsOpen} degrees={180} class="error-details-chevron">
              <ChevronDown size={12} strokeWidth={2} />
            </RotateIcon>
          </button>
          <Collapse open={detailsOpen}>
            <pre class="error-details">{error.details}</pre>
          </Collapse>
        </>
      )}
      {(action || secondaryAction) && (
        <div class="error-notice-actions">
          {secondaryAction && (
            <button
              type="button"
              class="error-notice-action secondary"
              disabled={secondaryAction.disabled}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
          {action && (
            <button
              type="button"
              class="error-notice-action"
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function presentError(message: string): { summary: string; details?: string } {
  const normalized = message.trim() || "The operation failed without an error message.";
  const firstLine = normalized.split(/\r?\n/, 1)[0]!.trim();
  const needsDetails = normalized.includes("\n") || firstLine.length > 220;
  return {
    summary: firstLine.length > 220 ? `${firstLine.slice(0, 219)}…` : firstLine,
    details: needsDetails ? normalized : undefined,
  };
}
