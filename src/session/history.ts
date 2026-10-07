import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  type Conversation,
  type ConversationId,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import type { SessionTreeItem, TranscriptMessage } from "../core/types";
import { messagePlainText } from "./sessionText";

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";
const PAGE = 500;

/** UI messages for the active transcript: model messages, with compactions and resets as notices. */
export function transcriptFromEntries(entries: readonly EntryRecord[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of entries) {
    if (CompactionEntry.is(entry)) {
      messages.push({
        role: "compactionSummary",
        summary: unwrapSummary(firstText(entry.model)),
        timestamp: messageTimestamp(entry) ?? Date.now(),
      });
      continue;
    }
    if (ResetEntry.is(entry)) {
      const handoff = firstText(entry.model);
      messages.push({
        role: "compactionSummary",
        summary: handoff ? `Context reset. Handoff:\n\n${handoff}` : "Context reset.",
        timestamp: messageTimestamp(entry) ?? Date.now(),
      });
      continue;
    }
    for (const message of entry.model ?? []) {
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
        messages.push(message);
    }
  }
  return messages;
}

/** Every visible entry of a conversation, oldest first, including those inherited from forks. */
export async function historyEntries(
  conversation: Conversation,
  context: Context,
  maxEntryId?: EntryId,
): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries(
      maxEntryId === undefined ? {} : { maxEntryId },
      PAGE,
      cursor,
      context,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries.reverse();
}

/**
 * Append copied entries to a conversation in one commit, renumbering the head and edit
 * references they carry. Entries whose references point outside the copy are dropped.
 */
export async function appendHistory(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly (EntryDraft & { id?: EntryId })[],
  context: Context,
): Promise<void> {
  if (!entries.length) return;
  await harness.commit(async (tx) => {
    const ids = new Map<EntryId, EntryId>();
    for (const entry of entries) {
      let head: EntryDraft["head"];
      if (entry.head !== undefined) {
        if (entry.head === "self" || entry.head === entry.id) head = "self";
        else {
          head = ids.get(entry.head);
          if (head === undefined) continue;
        }
      }
      const edits = entry.edits?.flatMap((edit) => {
        const target = ids.get(edit.target);
        return target === undefined ? [] : [{ ...edit, target }];
      });
      const appended = await tx.appendEntry(conversationId, {
        kind: entry.kind,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.data !== undefined ? { data: entry.data } : {}),
        ...(head !== undefined ? { head } : {}),
        ...(edits?.length ? { edits } : {}),
      });
      if (entry.id !== undefined) ids.set(entry.id, appended.id);
    }
  }, context);
}

/**
 * The branch tree of one chat: every conversation's own entries, linked to the entry
 * each fork starts from. System entries are hidden; their children attach to the
 * nearest visible ancestor.
 */
export async function buildTreeItems(
  harness: Harness,
  activeId: ConversationId,
  context: Context,
): Promise<SessionTreeItem[]> {
  const records = await harness.commit(async (tx) => {
    const all = [];
    let cursor: Parameters<typeof tx.scanConversations>[2];
    do {
      const page = await tx.scanConversations({}, PAGE, cursor);
      all.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return all;
  }, context);
  const parentOf = new Map<EntryId, EntryId | null>();
  const owned = new Map<EntryId, EntryRecord>();
  let activeVisible = new Set<EntryId>();
  let activeTip: EntryId | undefined;
  for (const record of records) {
    // Task-owned conversations belong to subagents, not to the user's branches.
    if (record.owner) continue;
    const conversation = await harness.conversation(record.id, context);
    if (!conversation) continue;
    const visible = await historyEntries(conversation, context);
    let previous: EntryId | null = record.parent?.at ?? null;
    for (const entry of visible) {
      if (entry.conversationId !== record.id) continue;
      owned.set(entry.id, entry);
      parentOf.set(entry.id, previous);
      previous = entry.id;
    }
    if (record.id === activeId) {
      activeVisible = new Set(visible.map((entry) => entry.id));
      activeTip = visible.at(-1)?.id;
    }
  }
  const shown = [...owned.values()]
    .filter((entry) => describeEntry(entry) !== undefined)
    .sort((a, b) => a.id - b.id);
  const shownIds = new Set(shown.map((entry) => entry.id));
  const displayAncestor = (id: EntryId | null | undefined): EntryId | null => {
    let next = id ?? null;
    while (next !== null && !shownIds.has(next)) next = parentOf.get(next) ?? null;
    return next;
  };
  const current = displayAncestor(activeTip);
  return shown.map((entry) => {
    const described = describeEntry(entry)!;
    const parent = displayAncestor(parentOf.get(entry.id));
    return {
      id: String(entry.id),
      parentId: parent === null ? null : String(parent),
      type: entry.kind,
      kind: described.kind,
      text: described.text,
      timestamp: new Date(messageTimestamp(entry) ?? 0).toISOString(),
      active: activeVisible.has(entry.id),
      current: entry.id === current,
    };
  });
}

function describeEntry(entry: EntryRecord): Pick<SessionTreeItem, "kind" | "text"> | undefined {
  if (CompactionEntry.is(entry))
    return {
      kind: "summary",
      text: `Compaction · ${oneLine(unwrapSummary(firstText(entry.model)))}`,
    };
  if (ResetEntry.is(entry)) return { kind: "summary", text: "Context reset" };
  if (UserEntry.is(entry))
    return { kind: "user", text: oneLine(firstText(entry.model)) || "User prompt" };
  if (AssistantEntry.is(entry))
    return { kind: "assistant", text: oneLine(firstText(entry.model)) || "Assistant response" };
  if (ToolResultEntry.is(entry)) {
    const message = entry.model?.[0];
    return {
      kind: "tool",
      text: message?.role === "toolResult" ? `Tool result · ${message.toolName}` : "Tool result",
    };
  }
  return undefined;
}

/** Pi CLI's session format (JSONL v3), so chats move between Acode and desktop Pi. */
export function toPiSessionJsonl(
  entries: readonly EntryRecord[],
  meta: { id: string; createdAt: number },
): string {
  const lines: unknown[] = [
    {
      type: "session",
      version: 3,
      id: meta.id,
      timestamp: new Date(meta.createdAt).toISOString(),
      cwd: "/",
    },
  ];
  const exportedIds = new Map<EntryId, string>();
  let parentId: string | null = null;
  for (const entry of entries) {
    const id = entry.id.toString(16).padStart(8, "0");
    const timestamp = new Date(messageTimestamp(entry) ?? Date.now()).toISOString();
    if (CompactionEntry.is(entry)) {
      const firstKept = entry.head === undefined ? undefined : exportedIds.get(entry.head);
      if (!firstKept) continue;
      lines.push({
        type: "compaction",
        id,
        parentId,
        timestamp,
        summary: unwrapSummary(firstText(entry.model)),
        firstKeptEntryId: firstKept,
        tokensBefore: 0,
      });
    } else if (UserEntry.is(entry) || AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
      const message = entry.model?.[0];
      if (!message) continue;
      lines.push({ type: "message", id, parentId, timestamp, message });
    } else continue;
    exportedIds.set(entry.id, id);
    parentId = id;
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/**
 * Entries for a Pi CLI session (JSONL v3): the branch ending at the last entry, with
 * user, assistant, and tool-result messages and compactions. Other entry types are skipped.
 */
export function fromPiSessionJsonl(text: string): (EntryDraft & { id: EntryId })[] {
  type Line = {
    type?: string;
    id?: string;
    parentId?: string | null;
    message?: Message & { role: string };
    summary?: string;
    firstKeptEntryId?: string;
    timestamp?: string;
  };
  const lines: Line[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      throw new Error(`Line ${index + 1} is not valid JSON.`);
    }
  }
  const header = lines[0];
  if (header?.type !== "session") throw new Error("Choose a Pi session file (.jsonl).");
  const byId = new Map(lines.filter((line) => line.id).map((line) => [line.id!, line]));
  const last = [...lines].reverse().find((line) => line.id && line.type !== "session");
  const path: Line[] = [];
  for (
    let cursor = last;
    cursor;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  ) {
    path.unshift(cursor);
    if (path.length > byId.size) throw new Error("The session file has a cycle.");
  }
  const numbers = new Map<string, EntryId>();
  const drafts: (EntryDraft & { id: EntryId })[] = [];
  for (const line of path) {
    const id = (drafts.length + 1) as EntryId;
    if (line.type === "message" && line.message) {
      const role = line.message.role;
      const kind =
        role === "user"
          ? UserEntry.kind
          : role === "assistant"
            ? AssistantEntry.kind
            : role === "toolResult"
              ? ToolResultEntry.kind
              : undefined;
      if (!kind) continue;
      drafts.push({
        id,
        kind,
        model: [line.message as Message],
        ...(kind === ToolResultEntry.kind ? { data: { diagnostics: [] } } : {}),
      });
    } else if (line.type === "compaction" && typeof line.summary === "string") {
      const head = line.firstKeptEntryId ? numbers.get(line.firstKeptEntryId) : undefined;
      if (head === undefined) continue;
      const summary: UserMessage = {
        role: "user",
        content: `${SUMMARY_PREFIX}${line.summary}${SUMMARY_SUFFIX}`,
        timestamp: line.timestamp ? Date.parse(line.timestamp) || Date.now() : Date.now(),
      };
      drafts.push({
        id,
        kind: CompactionEntry.kind,
        model: [summary],
        head,
        data: { reason: "manual" },
      });
    } else continue;
    if (line.id) numbers.set(line.id, id);
  }
  if (!drafts.length) throw new Error("The session file has no messages to import.");
  return drafts;
}

/** Text of the newest assistant message, for /copy. */
export function latestAssistantText(messages: readonly TranscriptMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return messagePlainText(message as AssistantMessage);
  }
  return "";
}

function firstText(model: readonly Message[] | undefined): string {
  const message = model?.[0];
  return message ? messagePlainText(message as TranscriptMessage) : "";
}

function messageTimestamp(entry: EntryRecord): number | undefined {
  const message = entry.model?.[0] as { timestamp?: unknown } | undefined;
  return typeof message?.timestamp === "number" ? message.timestamp : undefined;
}

function unwrapSummary(text: string): string {
  return text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
    ? text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length)
    : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
