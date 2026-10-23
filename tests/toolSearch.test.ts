import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, test } from "vitest";
import { preamble } from "../src/context/contextBuilder";
import {
  createToolSearchTool,
  findTools,
  syncDeferredTools,
  toolsInUse,
} from "../src/tools/toolSearch";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace";

function tool(name: string, description: string): ToolRegistration {
  return defineTool({
    name,
    description,
    parameters: Type.Object({ path: Type.String({ description: "Workspace path" }) }),
    execute: async () => ({}),
  });
}

const tools = [
  tool("move_path", "Move or rename a file or folder to a new path."),
  tool("rename_path", "Rename a file or folder in place, including case-only renames."),
  tool("delete_path", "Delete a file, or a folder with recursive."),
  tool("ask_user_question", "Ask the user to choose between options."),
];

describe("findTools", () => {
  test("loads exact names first", () => {
    expect(findTools("delete_path, ask_user_question", tools, 5).map((t) => t.name)).toEqual([
      "delete_path",
      "ask_user_question",
    ]);
  });

  test("ranks descriptions for a described need", () => {
    expect(findTools("rename files", tools, 5)[0]?.name).toBe("rename_path");
    expect(findTools("ask the user a question", tools, 1).map((t) => t.name)).toEqual([
      "ask_user_question",
    ]);
    expect(findTools("compile kotlin", tools, 5)).toEqual([]);
  });
});

/** A transaction over plain documents, keyed by kind. */
function fakeTx(agent: Record<string, unknown> = {}) {
  const docs: Record<string, Record<string, unknown>> = {
    [AgentDoc.definition.kind]: agent,
    "acode.deferred-tools": { known: [] },
  };
  return {
    tx: {
      doc: async (token: { definition: { kind: string } }) => docs[token.definition.kind],
    } as never,
    docs,
  };
}

describe("syncDeferredTools", () => {
  test("hides deferred tools, keeps loaded ones, and follows changes to the deferred set", async () => {
    const { tx, docs } = fakeTx();
    const agent = docs[AgentDoc.definition.kind]!;
    await syncDeferredTools(tx, 1 as never, ["move_path", "delete_path"]);
    expect(agent.tools).toEqual({ remove: ["move_path", "delete_path"] });

    // tool_search loaded move_path: the harness took it off the list.
    agent.tools = { remove: ["delete_path"] };
    await syncDeferredTools(tx, 1 as never, ["move_path", "delete_path", "plugin_tool"]);
    expect(agent.tools).toEqual({ remove: ["delete_path", "plugin_tool"] });

    // delete_path is no longer deferred, so it is declared again.
    await syncDeferredTools(tx, 1 as never, ["move_path", "plugin_tool"]);
    expect(agent.tools).toEqual({ remove: ["plugin_tool"] });

    await syncDeferredTools(tx, 1 as never, []);
    expect(agent.tools).toBeUndefined();
  });

  test("hides loaded tools again once the context no longer shows them", async () => {
    const { tx, docs } = fakeTx();
    const agent = docs[AgentDoc.definition.kind]!;
    const deferred = ["move_path", "delete_path", "rename_path"];
    await syncDeferredTools(tx, 1 as never, deferred);
    // tool_search loaded move_path and rename_path.
    agent.tools = { remove: ["delete_path"] };
    // Before compaction both are still visible in context: nothing changes.
    await syncDeferredTools(
      tx,
      1 as never,
      deferred,
      new Set(["move_path", "rename_path", "read"]),
    );
    expect(agent.tools).toEqual({ remove: ["delete_path"] });
    // After compaction only rename_path is still in use.
    await syncDeferredTools(tx, 1 as never, deferred, new Set(["rename_path"]));
    expect(agent.tools).toEqual({ remove: ["delete_path", "move_path"] });
  });

  test("leaves conversations that list their tools alone", async () => {
    const { tx, docs } = fakeTx({ tools: ["read", "grep"] });
    await syncDeferredTools(tx, 1 as never, ["move_path"]);
    expect(docs[AgentDoc.definition.kind]!.tools).toEqual(["read", "grep"]);
  });
});

describe("tool_search", () => {
  const run = (query: string, active: string[] = []) =>
    createToolSearchTool(tools).execute(
      { query } as never,
      { agent: async () => ({ tools: active.map((name) => ({ name })) }) } as never,
      BACKGROUND_CONTEXT,
    );

  test("loads matches through the tool round's control", async () => {
    const result = await run("rename_path");
    expect(result.control).toEqual({ addTools: ["rename_path"] });
    expect(JSON.stringify(result.output)).toContain(
      "rename_path: Rename a file or folder in place",
    );
  });

  test("skips tools that are already loaded", async () => {
    const result = await run("rename_path", ["rename_path"]);
    expect(result.control).toBeUndefined();
    expect(JSON.stringify(result.output)).toContain("Already loaded: rename_path.");
  });
});

test("the system prompt names deferred tools", () => {
  const workspace = { info: { name: "demo", remote: false, scheme: "file" } } as AcodeWorkspace;
  expect(
    preamble(workspace, { deferred: ["move_path", "ask_user_question"], codemode: true }),
  ).toContain(
    "Load these tools with tool_search before calling them: move_path, ask_user_question. Codemode scripts can call them without loading.",
  );
  expect(preamble(workspace)).not.toContain("tool_search");
});

test("toolsInUse counts calls and tools a search result still holds", () => {
  const used = toolsInUse([
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "rename_path", arguments: {} }],
    } as never,
    {
      role: "toolResult",
      toolCallId: "2",
      toolName: "tool_search",
      content: [{ type: "text", text: "Loaded 1 tool" }],
      details: { loaded: ["move_path"] },
      isError: false,
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "3",
      toolName: "tool_search",
      content: [
        {
          type: "text",
          text: "Loaded 1 tool; call them from your next turn:\n- delete_path: Delete a file.",
        },
      ],
      isError: false,
      timestamp: 1,
    },
  ]);
  expect([...used].sort()).toEqual(["delete_path", "move_path", "rename_path"]);
});
