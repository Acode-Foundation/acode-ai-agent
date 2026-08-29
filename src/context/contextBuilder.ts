import type { ExtensionRegistry } from "../core/extensionRegistry";
import type { AgentSettings } from "../core/types";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { resolveSourceFile, selectedText } from "../workspace/sourceFile";

export async function buildSystemPrompt(
	workspace: AcodeWorkspace,
	settings: AgentSettings,
	extensions: ExtensionRegistry,
): Promise<string> {
	const context: string[] = [
		"You are Acode's in-editor coding agent, powered by the Pi agent runtime.",
		"Work autonomously toward the user's requested outcome and use tools to inspect evidence before guessing.",
		"File-tool paths are POSIX and workspace-relative; never pass device paths, absolute paths, or URIs.",
		"Read open buffers before editing. Edits to open files remain unsaved so the user retains editor undo/save control.",
		"Prefer edit_file for focused changes and write_file for new files or deliberate whole-file rewrites.",
		"Never expose credentials, provider keys, hidden workspace URIs, or private values in tool results or responses.",
		`Workspace: ${workspace.info.name}. Storage: ${workspace.info.remote ? "remote; keep walks bounded and sequential" : workspace.info.scheme}.`,
		"Use web_search for current docs, APIs, package versions, and recent events instead of guessing. Follow with fetch_content when you need the full page. Cite source URLs.",
		"For 3+ step work, keep a live checklist with todo_write. Do not paste it into chat.",
	];
	for (const instructionsFile of ["AGENTS.md", ".agents.md"]) {
		try {
			const instructions = await workspace.readText(instructionsFile);
			context.push(`Project instructions from ${instructionsFile}:\n${instructions.slice(0, 32_000)}`);
			break;
		} catch {
			// Optional project instructions.
		}
	}

	const sourceFile = resolveSourceFile();
	if (sourceFile) {
		const relative = workspace.sandbox.relative(sourceFile.uri);
		if (relative !== undefined) {
			context.push(`Active editor file: ${relative}`);
			if (settings.includeSelection) {
				const selected = selectedText(sourceFile);
				if (selected) context.push(`Current selection from ${relative}:\n${selected.slice(0, 12_000)}`);
			}
		}
	}

	for (const source of extensions.contextSources) {
		try {
			const value = await source();
			if (value) context.push(value);
		} catch (error) {
			console.warn("AI context contribution failed", error);
		}
	}
	return context.join("\n\n");
}
