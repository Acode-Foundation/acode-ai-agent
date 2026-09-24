import type { PermissionMode } from "../core/schema";
import type { MutationDecision, MutationRequest } from "../core/types";
import { Signal } from "../core/events";
import { editPairs } from "../tools/textEdits";
import { formatSize } from "../tools/truncate";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";

export class MutationGate {
  readonly changes = new Signal<MutationRequest | undefined>();
  #pending?: MutationRequest;
  #sessionGrants = new Set<Category>();

  get pending(): MutationRequest | undefined {
    return this.#pending;
  }

  async request(
    toolName: string,
    args: Record<string, unknown>,
    workspace: AcodeWorkspace,
    mode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<{ block?: boolean; reason?: string }> {
    const category = categoryOf(toolName);
    if (!category) return {};
    if (mode === "full-access") return {};
    if (this.#sessionGrants.has(category) || (category === "edit" && mode === "allow-edits"))
      return {};
    const noun = NOUNS[category];
    if (signal?.aborted)
      return { block: true, reason: `${capitalize(noun)} was aborted before approval.` };
    if (this.#pending)
      return { block: true, reason: `Another ${noun} approval is already pending.` };

    const path = category === "shell" ? "." : String(args.path ?? args.source ?? "");
    const preview = await this.#buildPreview(toolName, args, workspace);
    const decision = await new Promise<MutationDecision>((resolve) => {
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const abort = () => this.resolve("deny");
      const finish = (value: MutationDecision) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      this.#pending = {
        id,
        toolName,
        path,
        title: approvalTitle(toolName, path),
        preview,
        resolve: finish,
      };
      this.changes.emit(this.#pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (decision === "allow-session") this.#sessionGrants.add(category);
    return decision === "deny" ? { block: true, reason: `User denied this ${noun}.` } : {};
  }

  resolve(decision: MutationDecision): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.changes.emit(undefined);
    pending.resolve(decision);
  }

  resetSessionApproval(): void {
    this.#sessionGrants.clear();
  }

  dispose(): void {
    this.resolve("deny");
    this.changes.clear();
  }

  async #buildPreview(
    toolName: string,
    args: Record<string, unknown>,
    workspace: AcodeWorkspace,
  ): Promise<string> {
    if (toolName === "bash") return truncate(String(args.command ?? ""), 2_800);
    if (toolName === "delete_path") return this.#deletePreview(args, workspace);
    if (toolName === "move_path" || toolName === "copy_path")
      return `${String(args.source ?? "")}\n→ ${String(args.destination ?? "")}`;
    if (toolName === "rename_path")
      return `${String(args.path ?? "")}\n→ ${String(args.new_name ?? "")}`;
    if (toolName === "create_directory") return `Create folder ${String(args.path ?? "")}`;
    if (toolName === "edit_file") {
      const pairs = editPairs(args);
      const budget = Math.max(200, Math.floor(1400 / Math.max(1, pairs.length)));
      return pairs
        .map((pair) => `− ${truncate(pair.oldText, budget)}\n+ ${truncate(pair.newText, budget)}`)
        .join("\n\n");
    }
    const next = String(args.content ?? "");
    try {
      const current = await workspace.readText(String(args.path ?? ""));
      return `Current (${current.length} chars) → proposed (${next.length} chars)\n\n${truncate(next, 2800)}`;
    } catch {
      return `Create file (${next.length} chars)\n\n${truncate(next, 2800)}`;
    }
  }

  /** Show what a delete takes with it: the file size, or a folder's first entries. */
  async #deletePreview(args: Record<string, unknown>, workspace: AcodeWorkspace): Promise<string> {
    const path = String(args.path ?? "");
    const recursive = args.recursive === true;
    try {
      const stat = await workspace.stat(path);
      if (stat?.isFile === true || stat?.isDirectory === false) {
        const size = Number(stat.size);
        return `Delete file ${path}${size >= 0 ? ` (${formatSize(size)})` : ""}. This cannot be undone.`;
      }
      const entries = await workspace.list(path);
      const shown = entries
        .slice(0, DELETE_PREVIEW_ENTRIES)
        .map((entry) => `  ${entry.name}${entry.isDirectory ? "/" : ""}`);
      const more = entries.length - shown.length;
      return [
        `Delete folder ${path}${recursive ? " and everything inside it" : ""} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}). This cannot be undone.`,
        ...shown,
        ...(more > 0 ? [`  … ${more} more`] : []),
      ].join("\n");
    } catch {
      return `Delete ${path}${recursive ? " (recursive)" : ""}. This cannot be undone.`;
    }
  }
}

const DELETE_PREVIEW_ENTRIES = 20;

type Category = "edit" | "delete" | "shell";

const EDIT_TOOLS = new Set([
  "write_file",
  "edit_file",
  "move_path",
  "rename_path",
  "copy_path",
  "create_directory",
]);

const NOUNS: Record<Category, string> = {
  edit: "workspace edit",
  delete: "delete",
  shell: "terminal command",
};

/** Edits pass in Allow edits mode; deletes and shell commands still ask. */
function categoryOf(toolName: string): Category | undefined {
  if (toolName === "bash") return "shell";
  if (toolName === "delete_path") return "delete";
  return EDIT_TOOLS.has(toolName) ? "edit" : undefined;
}

function approvalTitle(toolName: string, path: string): string {
  switch (toolName) {
    case "bash":
      return "Run terminal command";
    case "write_file":
      return `Write ${path}`;
    case "move_path":
      return `Move ${path}`;
    case "rename_path":
      return `Rename ${path}`;
    case "copy_path":
      return `Copy ${path}`;
    case "delete_path":
      return `Delete ${path}`;
    case "create_directory":
      return `Create folder ${path}`;
    default:
      return `Edit ${path}`;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… preview truncated` : value;
}
