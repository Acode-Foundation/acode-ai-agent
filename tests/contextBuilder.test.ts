import { expect, test } from "vitest";
import { systemPromptSections, preamble } from "../src/context/contextBuilder";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import type { ExtensionRegistry } from "../src/core/extensionRegistry";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";

const workspace = { info: { name: "demo", remote: false, scheme: "file" } } as AcodeWorkspace;

test("adds the codemode guideline only when the tool is offered", () => {
  expect(preamble(workspace, { codemode: true })).toContain(
    "Use codemode whenever a step needs two or more tool calls",
  );
  expect(preamble(workspace)).not.toContain("codemode");
});

test("renders configured AI instructions as a separate Pi prompt section", () => {
  const sections = systemPromptSections({
    workspace,
    settings: () => ({ ...DEFAULT_SETTINGS, aiInstructions: "  Keep answers concise.  " }),
    extensions: {} as ExtensionRegistry,
    skills: () => [],
  });
  const instructions = sections.find((promptSection) => promptSection.key === "user_instructions");

  expect(instructions?.render({} as never, {} as never)).toBe(
    "Additional user instructions:\nKeep answers concise.",
  );
});

test("omits the AI instruction section content when it is blank", () => {
  const sections = systemPromptSections({
    workspace,
    settings: () => ({ ...DEFAULT_SETTINGS, aiInstructions: "  \n " }),
    extensions: {} as ExtensionRegistry,
    skills: () => [],
  });
  const instructions = sections.find((promptSection) => promptSection.key === "user_instructions");

  expect(instructions?.render({} as never, {} as never)).toBeUndefined();
});
