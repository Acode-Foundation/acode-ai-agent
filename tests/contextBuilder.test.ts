import { expect, test } from "vitest";
import { preamble } from "../src/context/contextBuilder";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";

const workspace = { info: { name: "demo", remote: false, scheme: "file" } } as AcodeWorkspace;

test("adds the codemode guideline only when the tool is offered", () => {
  expect(preamble(workspace, { codemode: true })).toContain(
    "Use codemode whenever a step needs two or more tool calls",
  );
  expect(preamble(workspace)).not.toContain("codemode");
});

test("tells the model when the workspace has no shell", () => {
  expect(preamble(workspace, { shell: false })).toContain("no shell");
  expect(preamble(workspace, { shell: false })).toContain("acode_ui");
  expect(preamble(workspace, { shell: true })).not.toContain("no shell");
  expect(preamble(workspace)).not.toContain("no shell");
});
