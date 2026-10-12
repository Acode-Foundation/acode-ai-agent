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
