import { expect, test } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { redactJsonl } from "../src/platform/secretRedaction";
import {
  fromPiSessionJsonl,
  toPiSessionJsonl,
  transcriptFromEntries,
} from "../src/session/history";
import { expandPromptTemplate, parseCommandArgs } from "../src/session/promptTemplates";

const user = (text: string, timestamp = 1) => ({ role: "user" as const, content: text, timestamp });

test("imports the active branch of a Pi CLI session with its compaction", () => {
  const lines = [
    { type: "session", version: 3, id: "s", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/x" },
    { type: "message", id: "a", parentId: null, timestamp: "t", message: user("abandoned") },
    { type: "message", id: "b", parentId: null, timestamp: "t", message: user("first") },
    { type: "message", id: "c", parentId: "b", timestamp: "t", message: user("kept") },
    { type: "model_change", id: "d", parentId: "c", timestamp: "t", provider: "x", modelId: "y" },
    {
      type: "compaction",
      id: "e",
      parentId: "d",
      timestamp: "2026-10-01T00:00:00.000Z",
      summary: "Earlier work",
      firstKeptEntryId: "c",
      tokensBefore: 10,
    },
  ];
  const drafts = fromPiSessionJsonl(lines.map((line) => JSON.stringify(line)).join("\n"));
  expect(drafts.map((entry) => entry.kind)).toEqual(["pi.user", "pi.user", "pi.compaction"]);
  expect(drafts[2]!.head).toBe(drafts[1]!.id);

  const records = drafts.map((draft) => ({ ...draft, conversationId: 1 })) as EntryRecord[];
  expect(transcriptFromEntries(records).at(-1)).toMatchObject({
    role: "compactionSummary",
    summary: "Earlier work",
  });
  const exported = toPiSessionJsonl(records, { id: "chat", createdAt: 0 });
  expect(fromPiSessionJsonl(exported).map((entry) => entry.kind)).toEqual([
    "pi.user",
    "pi.user",
    "pi.compaction",
  ]);
});

test("rejects files that are not Pi sessions", () => {
  expect(() => fromPiSessionJsonl('{"type":"message"}')).toThrow("Choose a Pi session file");
  expect(() => fromPiSessionJsonl("not json")).toThrow("Line 1 is not valid JSON.");
});

test("expands Pi prompt-template arguments", () => {
  const args = parseCommandArgs(`fix "the login bug" quickly`);
  expect(args).toEqual(["fix", "the login bug", "quickly"]);
  expect(expandPromptTemplate("Do $1 for $2 ($@) ${@:2}", args)).toBe(
    "Do fix for the login bug (fix the login bug quickly) the login bug quickly",
  );
  expect(expandPromptTemplate("All: $ARGUMENTS", [])).toBe("All: ");
});

test("redacts provider keys in persisted records but keeps image data intact", () => {
  const image = { type: "image", data: "sk-abcdefghijklmnopqrst", mimeType: "image/png" };
  const line = JSON.stringify({
    text: "key sk-abcdefghijklmnopqrst and Bearer abcdefghijklmnop",
    image,
  });
  const redacted = JSON.parse(redactJsonl(`${line}\n`).trim());
  expect(redacted.text).toBe("key [REDACTED_API_KEY] and Bearer [REDACTED]");
  expect(redacted.image).toEqual(image);
});

test("ends a turn Pi recorded as aborted with a stop notice", () => {
  const entries = [
    { id: 1, conversationId: 1, kind: "pi.user", model: [user("run it", 10)] },
    {
      id: 2,
      conversationId: 1,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          content: [],
          isError: true,
          timestamp: 20,
        },
      ],
    },
    { id: 3, conversationId: 1, kind: "pi.user", model: [user("next", 30)] },
  ] as unknown as EntryRecord[];
  const messages = transcriptFromEntries(entries, new Set([1 as EntryRecord["id"]]));
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "toolResult",
    "runNotice",
    "user",
  ]);
  expect(messages[2]).toEqual({ role: "runNotice", timestamp: 20 });
});

test("tells a subagent to report once it has used its step budget", async () => {
  const { SUBAGENT_STEP_BUDGET, wrapUpReminder } = await import("../src/session/subagents");
  const turn = { role: "assistant", content: [], timestamp: 1 } as never;
  expect(wrapUpReminder(Array(SUBAGENT_STEP_BUDGET - 1).fill(turn))).toBeUndefined();
  expect(wrapUpReminder(Array(SUBAGENT_STEP_BUDGET).fill(turn))?.content).toContain(
    "Stop calling tools",
  );
});
