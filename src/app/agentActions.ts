import { filePlaceholder, type ComposerDraft, type DraftFile } from "../ui/composerDraft";

/** What an editor or terminal menu hands to the agent. */
export type ActionSubject =
  | {
      kind: "selection";
      /** Workspace-relative path, when the file lives in an open workspace. */
      path?: string;
      name: string;
      text: string;
      startLine?: number;
      endLine?: number;
    }
  | { kind: "file"; path?: string; name: string; text: string }
  | { kind: "terminal"; text: string };

export type SubjectKind = ActionSubject["kind"];
export type AgentActionId = "add" | "explain" | "fix" | "improve";

/** Adds to the composer for the user to finish, or submits right away. */
export type ComposerRequest = { draft: ComposerDraft; submit: boolean };

type ActionCopy = { label: string; instruction?: string };

const ACTIONS: Record<SubjectKind, Partial<Record<AgentActionId, ActionCopy>>> = {
  selection: {
    add: { label: "Add selection to chat" },
    explain: { label: "Explain selection", instruction: "Explain what this code does." },
    fix: { label: "Fix bugs in selection", instruction: "Find and fix bugs in this code." },
    improve: {
      label: "Improve selection",
      instruction: "Improve this code's readability and structure without changing its behavior.",
    },
  },
  file: {
    add: { label: "Add file to chat" },
    explain: { label: "Explain this file", instruction: "Explain what this file does." },
    fix: { label: "Review file for bugs", instruction: "Review this file for bugs and fix them." },
    improve: {
      label: "Improve this file",
      instruction: "Improve this file's readability and structure without changing its behavior.",
    },
  },
  terminal: {
    add: { label: "AI Agent: Add to chat" },
    explain: { label: "AI Agent: Explain", instruction: "Explain this terminal output." },
    fix: {
      label: "AI Agent: Fix error",
      instruction: "Diagnose the error in this terminal output and fix its cause in the workspace.",
    },
  },
};

export const ACTION_ICONS: Record<AgentActionId, string> = {
  add: "attach_file",
  explain: "info_outline",
  fix: "wand",
  improve: "autorenew",
};

/** Large enough for real code, small enough to keep one prompt from eating the context. */
export const MAX_SUBJECT_CHARS = 100_000;

export function actionsFor(kind: SubjectKind): Array<{ id: AgentActionId; label: string }> {
  return (Object.keys(ACTIONS[kind]) as AgentActionId[]).map((id) => ({
    id,
    label: ACTIONS[kind][id]!.label,
  }));
}

export function buildComposerRequest(
  action: AgentActionId,
  subject: ActionSubject,
): ComposerRequest {
  const copy = ACTIONS[subject.kind][action];
  if (!copy) throw new Error(`"${action}" is not available for a ${subject.kind}.`);
  const mention = subject.kind === "file" && subject.path ? `@${subject.path}` : undefined;
  const attachment = mention ? undefined : subjectAttachment(subject);
  const reference = mention ?? filePlaceholder(attachment!.name);
  if (!copy.instruction) {
    return {
      submit: false,
      draft: {
        text: mention ? `${mention} ` : "",
        images: [],
        files: attachment ? [attachment] : [],
      },
    };
  }
  return {
    submit: true,
    draft: {
      text: `${copy.instruction}\n\n${reference}`,
      images: [],
      files: attachment ? [attachment] : [],
    },
  };
}

function subjectAttachment(subject: ActionSubject): DraftFile {
  const { text, truncated } = clip(subject.text, subject.kind === "terminal");
  return {
    id: newAttachmentId(),
    name: subjectName(subject),
    content: text,
    encoding: "text",
    ...(truncated ? { truncated } : {}),
  };
}

export function subjectName(subject: ActionSubject): string {
  if (subject.kind === "terminal") return "terminal output";
  const file = subject.path || subject.name;
  const { startLine, endLine } = subject.kind === "selection" ? subject : {};
  if (!startLine) return file;
  return !endLine || endLine === startLine
    ? `${file}:${startLine}`
    : `${file}:${startLine}-${endLine}`;
}

/** Terminal errors sit at the end of the output, so keep the tail there. */
function clip(text: string, keepTail: boolean): { text: string; truncated: boolean } {
  if (text.length <= MAX_SUBJECT_CHARS) return { text, truncated: false };
  return {
    text: keepTail ? text.slice(-MAX_SUBJECT_CHARS) : text.slice(0, MAX_SUBJECT_CHARS),
    truncated: true,
  };
}

function newAttachmentId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}
