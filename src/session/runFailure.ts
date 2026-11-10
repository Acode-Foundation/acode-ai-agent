import type { LiveState } from "@earendil-works/pi-durable";
import type { RunFailureNotice } from "../core/types";

/** Why a prompt went unanswered, for the user: Pi's detail when it has one. */
export function describeUnanswered(reason: string, detail: unknown): string {
  // Pi's detail is the round count, such as "10 turns".
  if (reason === "turn_limit")
    return `Stopped after ${typeof detail === "string" ? detail.replace(/\bturns?\b/, (word) => (word === "turn" ? "tool round" : "tool rounds")) : "the tool round limit"}. Retry to continue, or raise the limit in Pi settings.`;
  const message =
    typeof detail === "string"
      ? detail
      : detail && typeof detail === "object" && "message" in detail
        ? String((detail as { message: unknown }).message)
        : undefined;
  return message || (UNANSWERED[reason] ?? `The prompt was not answered (${reason}).`);
}

const TITLES: Record<string, string> = {
  turn_limit: "Tool round limit reached",
  interrupted: "Run interrupted",
  restart_limit: "Run interrupted",
  no_model: "No model",
};

const UNANSWERED: Record<string, string> = {
  model_error: "The model request failed.",
  no_model: "No model is available for this chat.",
  interrupted: "The app stopped while the model was answering.",
  restart_limit: "The run was cut off too many times in a row.",
  turn_limit: "The run reached its tool round limit.",
  faulted: "The run failed.",
  orphaned: "The run could not continue.",
};

/** Failures a continue can fix; aborts, resets, and empty runs are the user's own doing. */
const RETRYABLE = new Set([
  "model_error",
  "no_model",
  "interrupted",
  "restart_limit",
  "turn_limit",
  "faulted",
]);
const SIGN_IN_ERROR =
  /oauth|refresh token|sign[ -]?in|log[ -]?in|unauthori[sz]ed|\b401\b|invalid (api )?key|authentication failed/i;

export function failureNotice(
  failure: LiveState["runFailure"],
  error: string | undefined,
): RunFailureNotice | undefined {
  if (!failure || failure.reason === "aborted") return undefined;
  // A turn limit is not an error; describe it rather than echo Pi's bare round count.
  const message =
    failure.reason === "turn_limit"
      ? describeUnanswered(failure.reason, failure.detail)
      : (error ?? describeUnanswered(failure.reason, failure.detail));
  return {
    title: TITLES[failure.reason] ?? "Request failed",
    message,
    retryable: RETRYABLE.has(failure.reason),
    signIn: failure.reason === "model_error" && SIGN_IN_ERROR.test(message),
  };
}
