import { expect, test } from "vitest";
import {
  actionsFor,
  buildComposerRequest,
  MAX_SUBJECT_CHARS,
  subjectName,
} from "../src/app/agentActions.ts";
import { Mailbox } from "../src/core/events.ts";
import { promptTextFromDraft, userPartsFromMessage } from "../src/ui/composerDraft.ts";

const selection = {
  kind: "selection" as const,
  path: "src/main.ts",
  name: "main.ts",
  text: "const a = 1;\nconst b = 2;",
  startLine: 12,
  endLine: 13,
};

test("names attachments after the workspace path and line range", () => {
  expect(subjectName(selection)).toBe("src/main.ts:12-13");
  expect(subjectName({ ...selection, endLine: 12 })).toBe("src/main.ts:12");
  expect(subjectName({ ...selection, path: undefined, startLine: undefined })).toBe("main.ts");
  expect(subjectName({ kind: "terminal", text: "boom" })).toBe("terminal output");
});

test("adding a selection attaches it to the composer without submitting", () => {
  const request = buildComposerRequest("add", selection);
  expect(request.submit).toBe(false);
  expect(request.draft.text).toBe("");
  expect(request.draft.files).toMatchObject([
    { name: "src/main.ts:12-13", content: selection.text, encoding: "text" },
  ]);
});

test("adding a workspace file inserts an @ mention instead of its content", () => {
  const request = buildComposerRequest("add", {
    kind: "file",
    path: "src/main.ts",
    name: "main.ts",
    text: "whole file",
  });
  expect(request).toEqual({
    submit: false,
    draft: { text: "@src/main.ts ", images: [], files: [] },
  });
});

test("files outside every workspace are attached by name", () => {
  const request = buildComposerRequest("explain", {
    kind: "file",
    name: "notes.md",
    text: "# Notes",
  });
  expect(request.draft.text).toBe("Explain what this file does.\n\n[#file notes.md]");
  expect(request.draft.files[0]).toMatchObject({ name: "notes.md", content: "# Notes" });
});

test("submitted actions render as an instruction plus an attachment chip", () => {
  const request = buildComposerRequest("fix", selection);
  expect(request.submit).toBe(true);
  const parts = userPartsFromMessage(promptTextFromDraft(request.draft));
  expect(parts).toEqual([
    { type: "text", text: "Find and fix bugs in this code.\n\n" },
    expect.objectContaining({
      type: "attachment",
      name: "src/main.ts:12-13",
      content: selection.text,
    }),
  ]);
});

test("long terminal output keeps its tail and is marked truncated", () => {
  const text = `${"x".repeat(MAX_SUBJECT_CHARS)}Error: the end`;
  const [file] = buildComposerRequest("explain", { kind: "terminal", text }).draft.files;
  expect(file?.truncated).toBe(true);
  expect(file?.content.length).toBe(MAX_SUBJECT_CHARS);
  expect(file?.content.endsWith("Error: the end")).toBe(true);
});

test("terminal menus offer no refactor action", () => {
  expect(actionsFor("terminal").map((action) => action.id)).toEqual(["add", "explain", "fix"]);
  expect(() => buildComposerRequest("improve", { kind: "terminal", text: "x" })).toThrow();
});

test("mailbox holds posts until a receiver attaches", () => {
  const mailbox = new Mailbox<number>();
  const received: number[] = [];
  mailbox.post(1);
  mailbox.post(2);
  const stop = mailbox.receive((value) => received.push(value));
  mailbox.post(3);
  stop();
  mailbox.post(4);
  expect(received).toEqual([1, 2, 3]);
  mailbox.receive((value) => received.push(value));
  expect(received).toEqual([1, 2, 3, 4]);
});
