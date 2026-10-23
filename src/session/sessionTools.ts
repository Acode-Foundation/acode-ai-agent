import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Page,
  type Storage,
  type ToolExecutionResult,
  type ToolRegistration,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { TranscriptMessage } from "../core/types";
import type { ChatMeta, ChatStore } from "./chatStore";
import { stoppedPrompts, transcriptFromEntries } from "./history";
import { messagePlainText } from "./sessionText";

export const LIST_SESSIONS_TOOL_NAME = "list_sessions";
export const READ_SESSION_TOOL_NAME = "read_session";

const PAGE = 500;
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_TURN_LIMIT = 20;
/** Chats whose text a `list_sessions` query searches, newest first; titles are always searched. */
const SEARCH_CHATS = 50;
/** Prompt and reply text kept per turn in the overview. */
const SUMMARY_CHARS = 400;
/** Text kept per item when reading one turn, unless `maxChars` asks for more. */
const DEFAULT_ITEM_CHARS = 4_000;
const MAX_ITEM_CHARS = 50_000;
/** Task states that mean work is still live in the chat. */
const LIVE_TASKS = ["pending", "running", "waiting"] as const;

type ChatStatus = "running" | "interrupted" | "idle";

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  cost: number;
};

/** One prompt and everything the agent did for it. */
type Turn = { prompt: TranscriptMessage; messages: TranscriptMessage[]; stopped: boolean };

type Item =
  | { type: "prompt"; text: string; truncated?: true }
  | { type: "reply"; model: string; text: string; truncated?: true }
  | { type: "tool"; name: string; args: string; result?: string; error?: true; truncated?: true }
  | { type: "notice"; text: string; truncated?: true };

type Details = { operation: string; count: number };

/**
 * Tools that find chats and read one. They read the chat's Pi storage directly: entries for the
 * turns, each conversation's `pi.usage` for the totals, so subagents and compaction count too, and
 * live tasks for the status. Output is JSON, so a codemode script can `JSON.parse` it.
 */
export function createSessionTools(store: ChatStore, currentId: string): ToolRegistration[] {
  const listSessions = defineTool({
    name: LIST_SESSIONS_TOOL_NAME,
    description:
      "List chats as JSON, newest first, with ids for read_session. `query` matches the title, the workspace " +
      `name, and the prompt and reply text of the ${SEARCH_CHATS} newest chats; text matches carry a snippet. ` +
      "Page with offset=nextOffset.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Text to find" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Results to skip" })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: `Default ${DEFAULT_LIST_LIMIT}` }),
      ),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, _api, context) => {
      await store.hydrate();
      const query = args.query?.trim().toLowerCase();
      const offset = args.offset ?? 0;
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      const found: Array<Record<string, unknown>> = [];
      let searched = 0;
      let partial = false;
      for (const chat of store.list()) {
        // One past the page tells whether there is a next page.
        if (found.length > offset + limit) break;
        let match: string | undefined;
        if (
          query &&
          !chat.title.toLowerCase().includes(query) &&
          !chat.workspaceName.toLowerCase().includes(query)
        ) {
          if (searched >= SEARCH_CHATS) {
            partial = true;
            continue;
          }
          searched += 1;
          match = await store
            .readStorage(chat.id, (storage) => findText(storage, chat, query, context))
            .catch(() => undefined);
          if (!match) continue;
        }
        found.push({
          id: chat.id,
          title: chat.title,
          workspace: chat.workspaceName,
          updated: iso(chat.updatedAt),
          ...(chat.id === currentId ? { current: true } : {}),
          ...(match ? { match } : {}),
        });
      }
      const sessions = found.slice(offset, offset + limit);
      return json(
        {
          sessions,
          ...(found.length > offset + limit ? { nextOffset: offset + limit } : {}),
          ...(partial ? { searchedText: `newest ${SEARCH_CHATS} chats` } : {}),
        },
        "list",
        sessions.length,
      );
    },
  });

  const readSession = defineTool({
    name: READ_SESSION_TOOL_NAME,
    description:
      "Read a chat as JSON. Without `turn`: its status (running, interrupted, idle), branch and subagent counts, " +
      "usage totals by model and tool, and its turns: prompt and reply cut short, models, tools used, status, " +
      "usage; page with offset=nextOffset. With `turn`: that turn in full, in order: the prompt, each reply, and " +
      "each tool call with its arguments and result, each item cut at maxChars. Omit id for this chat.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Chat id from list_sessions" })),
      turn: Type.Optional(Type.Integer({ minimum: 1, description: "Turn number to read in full" })),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "First turn to list. Default: the last turns" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 100, description: `Default ${DEFAULT_TURN_LIMIT}` }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 100,
          maximum: MAX_ITEM_CHARS,
          description: `Characters per item when reading a turn. Default ${DEFAULT_ITEM_CHARS}`,
        }),
      ),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, _api, context) => {
      await store.hydrate();
      const id = args.id?.trim() || currentId;
      const meta = store.get(id);
      if (!meta) throw new Error(`No chat has the id "${id}". Call list_sessions for ids.`);
      const chat = await store.readStorage(id, (storage, open) =>
        readChat(storage, meta, open, context),
      );
      const header = {
        id: meta.id,
        title: meta.title,
        workspace: meta.workspaceName,
        status: chat.status,
      };
      const running = chat.status === "running";

      if (args.turn !== undefined) {
        const turn = chat.turns[args.turn - 1];
        if (!turn)
          throw new Error(`Turn ${args.turn} does not exist; the chat has ${chat.turns.length}.`);
        const last = args.turn === chat.turns.length;
        const items = turnItems(turn, args.maxChars ?? DEFAULT_ITEM_CHARS);
        return json(
          {
            ...header,
            turn: args.turn,
            time: iso(turn.prompt.timestamp),
            ...turnStatus(turn, running && last),
            usage: sumTotals(assistants(turn).map((message) => message.usage)),
            items,
          },
          "read",
          items.length,
        );
      }

      const limit = args.limit ?? DEFAULT_TURN_LIMIT;
      const count = chat.turns.length;
      const start = args.offset === undefined ? Math.max(0, count - limit) : args.offset - 1;
      const turns = chat.turns
        .slice(start, start + limit)
        .map((turn, index) =>
          turnSummary(turn, start + index + 1, running && start + index + 1 === count),
        );
      const end = start + turns.length;
      return json(
        {
          ...header,
          created: iso(meta.createdAt),
          updated: iso(meta.updatedAt),
          branches: chat.branches,
          subagents: chat.subagents,
          turnCount: count,
          totals: {
            ...sumTotals([...Object.values(chat.usage.models), ...Object.values(chat.usage.tools)]),
            byModel: mapValues(chat.usage.models, totals),
            byTool: mapValues(chat.usage.tools, totals),
          },
          turns,
          ...(end < count ? { nextOffset: end + 1 } : {}),
        },
        "read",
        turns.length,
      );
    },
  });

  return [listSessions, readSession];
}

async function readChat(storage: Storage, meta: ChatMeta, open: boolean, context: Context) {
  const turns = groupTurns(await visibleMessages(storage, meta, context));
  const conversations = await scanAll((cursor) =>
    storage.scanConversations({}, PAGE, cursor, context),
  );
  // The chat's spend is every conversation's: branches, subagents, and compactions.
  const usage: UsageState = { models: {}, tools: {} };
  for (const { id } of conversations) {
    const address = {
      kind: UsageDoc.definition.kind,
      scope: { kind: "conversation" as const, conversationId: id },
    };
    const record = await storage.findDocument(address, "current", context);
    const doc = record && (await storage.document(record.id, "current", context));
    const state = doc?.value as UsageState | undefined;
    for (const bucket of ["models", "tools"] as const)
      for (const [key, item] of Object.entries(state?.[bucket] ?? {}))
        usage[bucket][key] = addUsage(usage[bucket][key], item as Usage);
  }
  const live = await Promise.all(
    LIVE_TASKS.map((status) => storage.scanTasks({ status }, 1, undefined, context)),
  );
  // Live work in a closed chat waits for the user to resume it.
  const busy = live.some((page) => page.items.length > 0);
  const status: ChatStatus = busy ? (open ? "running" : "interrupted") : "idle";
  return {
    turns,
    usage,
    status,
    branches: conversations.filter((item) => item.parent && !item.owner).length,
    subagents: conversations.filter((item) => item.owner).length,
  };
}

/** The first prompt or reply in the chat that contains `needle`, as a snippet around it. */
async function findText(
  storage: Storage,
  meta: ChatMeta,
  needle: string,
  context: Context,
): Promise<string | undefined> {
  for (const message of await visibleMessages(storage, meta, context)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = compact(messagePlainText(message));
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - 80);
    const to = Math.min(text.length, at + needle.length + 80);
    return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
  }
  return undefined;
}

/** The transcript of the conversation the chat shows. */
async function visibleMessages(
  storage: Storage,
  meta: ChatMeta,
  context: Context,
): Promise<TranscriptMessage[]> {
  const conversationId = (meta.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId;
  const entries = await scanAll<EntryRecord>((cursor) =>
    storage.scanEntries({ conversationId, order: "ascending" }, PAGE, cursor, context),
  );
  return transcriptFromEntries(entries, await stoppedPrompts(storage, context));
}

function groupTurns(messages: readonly TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ prompt: message, messages: [], stopped: false });
    else if (message.role === "runNotice") {
      const turn = turns.at(-1);
      if (turn) turn.stopped = true;
    } else turns.at(-1)?.messages.push(message);
  }
  return turns;
}

function turnSummary(turn: Turn, number: number, running: boolean) {
  const replies = assistants(turn);
  const tools: Record<string, number> = {};
  for (const message of replies)
    for (const part of message.content)
      if (part.type === "toolCall") tools[part.name] = (tools[part.name] ?? 0) + 1;
  const texts = replies.map((message) => messagePlainText(message)).filter((text) => text.trim());
  return {
    turn: number,
    time: iso(turn.prompt.timestamp),
    prompt: summary(messagePlainText(turn.prompt)),
    reply: summary(texts.at(-1) ?? ""),
    models: [...new Set(replies.map(modelOf))],
    ...(Object.keys(tools).length ? { tools } : {}),
    ...turnStatus(turn, running),
    usage: sumTotals(replies.map((message) => message.usage)),
  };
}

/** Nothing for a turn that finished; otherwise how it ended, or that it is still running. */
function turnStatus(turn: Turn, running: boolean): { status?: string; error?: string } {
  if (running) return { status: "running" };
  if (turn.stopped) return { status: "stopped" };
  const last = assistants(turn).at(-1);
  if (last?.stopReason === "error")
    return { status: "error", ...(last.errorMessage ? { error: last.errorMessage } : {}) };
  return {};
}

/** The turn in order: prompt, replies, tool calls with their results, and notices. */
function turnItems(turn: Turn, maxChars: number): Item[] {
  const items: Item[] = [{ type: "prompt", ...cut(messagePlainText(turn.prompt), maxChars) }];
  const calls = new Map<string, Extract<Item, { type: "tool" }>>();
  for (const message of turn.messages) {
    if (message.role === "assistant") {
      const text = messagePlainText(message);
      if (text.trim())
        items.push({ type: "reply", model: modelOf(message), ...cut(text, maxChars) });
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const args = cut(JSON.stringify(part.arguments), maxChars);
        const item: Extract<Item, { type: "tool" }> = {
          type: "tool",
          name: part.name,
          args: args.text,
          ...(args.truncated ? { truncated: true } : {}),
        };
        calls.set(part.id, item);
        items.push(item);
      }
    } else if (message.role === "toolResult") {
      const item = calls.get(message.toolCallId);
      if (!item) continue;
      const images = message.content.filter((part) => part.type === "image").length;
      const result = cut(
        messagePlainText(message) + (images ? `\n[${images} image${images > 1 ? "s" : ""}]` : ""),
        maxChars,
      );
      item.result = result.text;
      if (result.truncated) item.truncated = true;
      if (message.isError) item.error = true;
    } else if (message.role === "compactionSummary")
      items.push({ type: "notice", ...cut(messagePlainText(message), maxChars) });
  }
  if (turn.stopped) items.push({ type: "notice", text: "The user stopped this turn." });
  return items;
}

function assistants(turn: Turn): AssistantMessage[] {
  return turn.messages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
}

function modelOf(message: AssistantMessage): string {
  return `${message.provider}/${message.model}`;
}

async function scanAll<T>(
  scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}

function addUsage(total: Usage | undefined, usage: Usage): Usage {
  if (!total) return usage;
  return {
    ...total,
    input: total.input + (usage.input ?? 0),
    output: total.output + (usage.output ?? 0),
    cacheRead: total.cacheRead + (usage.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0),
    totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
    cost: { ...total.cost, total: (total.cost?.total ?? 0) + (usage.cost?.total ?? 0) },
  };
}

function totals(usage: Usage | undefined): Totals {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    tokens: usage?.totalTokens ?? 0,
    cost: roundCost(usage?.cost?.total ?? 0),
  };
}

function sumTotals(usages: readonly (Usage | undefined)[]): Totals {
  const sum = totals(undefined);
  for (const usage of usages) {
    const item = totals(usage);
    for (const key of Object.keys(sum) as (keyof Totals)[]) sum[key] += item[key];
  }
  sum.cost = roundCost(sum.cost);
  return sum;
}

function mapValues<T, R>(record: Record<string, T>, map: (value: T) => R): Record<string, R> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}

function roundCost(cost: number): number {
  return Math.round(cost * 1e6) / 1e6;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One line for the overview. */
function summary(text: string): string {
  const line = compact(text);
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS)}…` : line;
}

/** Full text up to `max` characters, flagged when cut. */
function cut(text: string, max: number): { text: string; truncated?: true } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text };
}

function json(value: unknown, operation: string, count: number): ToolExecutionResult<Details> {
  return {
    output: [{ type: "text", text: JSON.stringify(value) }],
    details: { operation, count },
  };
}
