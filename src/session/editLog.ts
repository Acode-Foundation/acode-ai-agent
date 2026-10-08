import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  UserEntry,
  type ConversationId,
  type EntryId,
  type Tx,
} from "@earendil-works/pi-durable";

/** Files above this size are recorded as not revertible instead of being copied into the chat. */
export const MAX_SNAPSHOT_CHARS = 512 * 1024;

/** One file a run changed: its content before the run's first write and after its latest. */
export type FileSnapshot = {
  /** `null`: the file did not exist before the run. */
  before: string | null;
  /** `null`: not written yet, or the write failed. */
  after: string | null;
  /** Too large or unreadable when recorded; revert leaves this file alone. */
  skipped?: boolean;
};

export type RunEdits = {
  files: Record<string, FileSnapshot>;
  /** When the user reverted this run. */
  revertedAt?: number;
};

/**
 * File snapshots per run, keyed by the user entry that started the run. Stored with the
 * conversation, so they survive restarts and a fork starts with its parent's history.
 */
export const EditsDoc = defineDoc<{ runs: Record<string, RunEdits> }>({
  kind: "acode.edits",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ runs: {} }),
});

/**
 * The user conversation and run a write belongs to. A subagent's write belongs to the run
 * of the conversation that started it, so reverting that run also reverts the subagent's edits.
 */
export async function runOf(
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ conversationId: ConversationId; entryId: EntryId } | undefined> {
  let current = conversationId;
  for (let depth = 0; depth < 16; depth += 1) {
    const record = await tx.conversation(current);
    if (!record?.owner) break;
    current = record.owner.conversationId;
  }
  let cursor: Parameters<Tx["scanEntries"]>[2];
  do {
    const page = await tx.scanEntries({ conversationId: current }, 50, cursor);
    const user = page.items.find((entry) => UserEntry.is(entry));
    if (user) return { conversationId: current, entryId: user.id };
    cursor = page.next;
  } while (cursor);
  return undefined;
}

/** The tool call making a change: its conversation and its commit. */
export type EditCall = {
  readonly conversationId: ConversationId;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
};

/** Callbacks the `write` and `edit` tools use around each change. */
export type EditRecorder = {
  /** Before the change: record the file's current content, once per run. */
  before(call: EditCall, path: string, context: Context): Promise<void>;
  /** After the change: record the content the agent left. */
  after(call: EditCall, path: string, context: Context): Promise<void>;
};

/**
 * An edit recorder over a reader of the workspace's current file content: a string, `null`
 * when the file does not exist, or `undefined` when it exists but cannot be read.
 */
export function createEditRecorder(
  read: (path: string) => Promise<string | null | undefined>,
): EditRecorder {
  const snapshot = async (path: string) => {
    const content = await read(path);
    return content === undefined || (content !== null && content.length > MAX_SNAPSHOT_CHARS)
      ? { content: null, skipped: true }
      : { content, skipped: false };
  };
  return {
    async before(call, path, context) {
      const current = await snapshot(path);
      await call.commit(async (tx) => {
        const run = await runOf(tx, call.conversationId);
        if (!run) return;
        const doc = await tx.doc(EditsDoc, run.conversationId);
        // Re-read after assigning: only the document draft records changes, not the literal.
        const key = String(run.entryId);
        doc.runs[key] ??= { files: {} };
        const edits = doc.runs[key]!;
        if (path in edits.files) return;
        edits.files[path] = {
          before: current.content,
          after: null,
          ...(current.skipped ? { skipped: true } : {}),
        };
      }, context);
    },
    async after(call, path, context) {
      const current = await snapshot(path);
      await call.commit(async (tx) => {
        const run = await runOf(tx, call.conversationId);
        if (!run) return;
        const doc = await tx.doc(EditsDoc, run.conversationId);
        const file = doc.runs[String(run.entryId)]?.files[path];
        if (!file) return;
        file.after = current.content;
        if (current.skipped) file.skipped = true;
      }, context);
    },
  };
}
