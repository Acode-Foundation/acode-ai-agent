import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineTool,
  type EntryId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

export const SUBAGENT_TOOL_NAME = "subagent";

/** Model turns a subagent gets before it is told to stop using tools and report. */
export const SUBAGENT_STEP_BUDGET = 30;

/**
 * After the budget, each request reminds the subagent to wrap up. Counted from the
 * request's own messages, so it holds across restarts.
 */
export function wrapUpReminder(messages: readonly Message[]): Message | undefined {
  const steps = messages.filter((message) => message.role === "assistant").length;
  if (steps < SUBAGENT_STEP_BUDGET) return undefined;
  return {
    role: "user",
    content:
      `<system-reminder>You have used your ${SUBAGENT_STEP_BUDGET}-step budget. Stop calling tools now and ` +
      "write your report from what you found, including what you could not confirm.</system-reminder>",
    timestamp: Date.now(),
  };
}

/** Answers longer than this are cut so one delegation cannot flood the parent's context. */
const MAX_ANSWER_CHARS = 16_000;

/** Tools a child never gets: no nested delegation, and no talking to the user or their task list. */
const PARENT_ONLY_TOOLS = new Set([SUBAGENT_TOOL_NAME, "todo_write", "ask_user_question"]);

/** Tools an `explore` child may use: it reads and searches, and never changes the workspace. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "list_dir",
  "grep",
  "glob",
  "load_skill",
  "web_search",
  "fetch_content",
]);

type Profile = { tools: (name: string) => boolean; instructions: string };

const PROFILES = {
  explore: {
    tools: (name) => READ_ONLY_TOOLS.has(name),
    instructions:
      "You are a read-only subagent exploring for another agent. Find what the task asks for with targeted searches " +
      "and reads, then reply with a compact report: exact workspace paths and line numbers, the relevant code, and " +
      "what you could not confirm. You cannot change files.",
  },
  general: {
    tools: (name) => !PARENT_ONLY_TOOLS.has(name),
    instructions:
      "You are a subagent doing one self-contained task for another agent. Stay inside the task, make the smallest " +
      "correct change, and reply with a compact report: what you did, files changed, how you checked it, and anything " +
      "left open. Ask nothing; if a decision is missing, stop and say so in the report.",
  },
} satisfies Record<string, Profile>;

export type SubagentProfile = keyof typeof PROFILES;

/** What the running call reports so the UI can follow the child. */
export type SubagentDetails = {
  conversationId: number;
  agent: SubagentProfile;
  task: string;
};

/**
 * Pi's subagent pattern: the call creates a child conversation it owns, runs the task there,
 * and returns the child's answer. Because the call owns the child, stopping the parent stops
 * the child, and the parent waits for it. The call is replay-safe: after a crash the rerun
 * finds the same child and the same submission, so the child continues instead of restarting.
 * Several calls in one turn run in parallel.
 */
export function createSubagentTool(tools: () => readonly ToolRegistration[]): ToolRegistration {
  return defineTool({
    name: SUBAGENT_TOOL_NAME,
    description:
      "Delegate a self-contained task to a subagent with its own context and get its report back. " +
      "Use agent=explore (default) to search and read without filling your context, for example to map a feature or " +
      "find every caller; use agent=general for a separable change. Write a complete task: the child sees none of " +
      "this conversation. Several subagent calls in one turn run in parallel. Subagents cannot ask the user, keep " +
      "the task list, or start subagents; their edits still need the user's approval.",
    parameters: Type.Object({
      task: Type.String({ description: "Complete instructions; the subagent sees nothing else" }),
      agent: Type.Optional(
        Type.Union([Type.Literal("explore"), Type.Literal("general")], {
          description: "explore: read-only research (default). general: may edit and run commands.",
        }),
      ),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, api, callContext) => {
      const agent: SubagentProfile = args.agent ?? "explore";
      const profile: Profile = PROFILES[agent];
      const child = await api.commit(async (tx) => {
        // Ownership records the child, so a rerun of this call reuses it.
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const created = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        // The child starts as a copy of this conversation's agent: model, thinking level, extensions.
        await configure(tx, created.id, {
          tools: tools().filter((tool) => profile.tools(tool.name)),
          instructions: profile.instructions,
        });
        return created.id;
      }, callContext);
      const details: SubagentDetails = { conversationId: child, agent, task: args.task };
      await api.details(details, callContext);

      const handle = await api.conversation(child, callContext);
      if (!handle) throw new Error("The subagent conversation is missing.");
      const settled = await (
        await handle.submit(
          { type: "input", content: args.task, requestId: `subagent:${api.taskId}` },
          callContext,
        )
      ).wait(callContext);
      if (settled.status !== "done" || settled.type !== "input")
        throw new Error(
          `The subagent did not finish (${settled.status === "unanswered" ? settled.reason : settled.status}).`,
        );
      const text = await answerText(api, settled.answer, callContext);
      return { content: [{ type: "text", text: capAnswer(text) }], details };
    },
  });
}

async function answerText(
  api: ToolExecutionApi,
  answer: EntryId,
  context: Context,
): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  const text = (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  return text || "The subagent finished without a written report.";
}

function capAnswer(text: string): string {
  if (text.length <= MAX_ANSWER_CHARS) return text;
  return `${text.slice(0, MAX_ANSWER_CHARS)}\n\n[Subagent report cut at ${MAX_ANSWER_CHARS} characters.]`;
}

export function isSubagentDetails(value: unknown): value is SubagentDetails {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { conversationId?: unknown }).conversationId === "number"
  );
}
