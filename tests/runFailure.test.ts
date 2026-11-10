import type { LiveState } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { describeUnanswered, failureNotice } from "../src/session/runFailure";

const failure = (reason: string, detail?: string) =>
  ({ taskId: 1, inputs: [], reason, detail }) as unknown as LiveState["runFailure"];

test("a provider error offers Retry, and Sign in when the login was rejected", () => {
  const oauth =
    "OAuth refresh failed for xai: auth.x.ai authentication failed (HTTP 400): Invalid or unknown refresh token";
  expect(failureNotice(failure("model_error"), oauth)).toEqual({
    title: "Request failed",
    message: oauth,
    retryable: true,
    signIn: true,
  });
  expect(failureNotice(failure("model_error"), "429 Too Many Requests")).toMatchObject({
    retryable: true,
    signIn: false,
  });
});

test("stops by the user are not failures, and resets are not retried", () => {
  expect(failureNotice(failure("aborted"), undefined)).toBeUndefined();
  expect(failureNotice(undefined, "error")).toBeUndefined();
  expect(failureNotice(failure("reset"), undefined)?.retryable).toBe(false);
  expect(failureNotice(failure("nothing_to_answer"), undefined)?.retryable).toBe(false);
});

test("Pi's detail explains the failure, with a plain fallback", () => {
  expect(failureNotice(failure("turn_limit", "40 turns"), "40 turns")).toMatchObject({
    title: "Tool round limit reached",
    message: "Stopped after 40 tool rounds. Retry to continue, or raise the limit in Pi settings.",
    retryable: true,
  });
  expect(describeUnanswered("turn_limit", "1 turn")).toMatch(/^Stopped after 1 tool round\./);
  expect(describeUnanswered("interrupted", undefined)).toBe(
    "The app stopped while the model was answering.",
  );
  expect(describeUnanswered("model_error", { message: "boom" })).toBe("boom");
  expect(describeUnanswered("weird", undefined)).toBe("The prompt was not answered (weird).");
});
