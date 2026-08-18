import type { PermissionMode } from "../core/schema";
import type { MutationDecision, MutationRequest } from "../core/types";
import { Signal } from "../core/events";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";

export class MutationGate {
	readonly changes = new Signal<MutationRequest | undefined>();
	#pending?: MutationRequest;
	#allowEditsForSession = false;

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
		if (toolName !== "write_file" && toolName !== "edit_file") return {};
		if (mode === "full-access" || mode === "allow-edits" || this.#allowEditsForSession) return {};
		if (signal?.aborted) return { block: true, reason: "Edit was aborted before approval." };
		if (this.#pending) return { block: true, reason: "Another edit approval is already pending." };

		const path = String(args.path ?? "");
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
				title: toolName === "write_file" ? `Write ${path}` : `Edit ${path}`,
				preview,
				resolve: finish,
			};
			this.changes.emit(this.#pending);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
		if (decision === "allow-session") this.#allowEditsForSession = true;
		return decision === "deny" ? { block: true, reason: "User denied this workspace edit." } : {};
	}

	resolve(decision: MutationDecision): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		this.changes.emit(undefined);
		pending.resolve(decision);
	}

	resetSessionApproval(): void {
		this.#allowEditsForSession = false;
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
		if (toolName === "edit_file") {
			return `− ${truncate(String(args.old_string ?? ""), 1400)}\n+ ${truncate(String(args.new_string ?? ""), 1400)}`;
		}
		const next = String(args.content ?? "");
		try {
			const current = await workspace.readText(String(args.path ?? ""));
			return `Current (${current.length} chars) → proposed (${next.length} chars)\n\n${truncate(next, 2800)}`;
		} catch {
			return `Create file (${next.length} chars)\n\n${truncate(next, 2800)}`;
		}
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}\n… preview truncated` : value;
}
