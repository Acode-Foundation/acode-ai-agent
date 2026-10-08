import { section, type PromptSection } from "@earendil-works/pi-durable";
import type { ExtensionRegistry } from "../core/extensionRegistry";
import type { AgentSettings } from "../core/types";
import type { Skill } from "../session/promptTemplates";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { resolveSourceFile, selectedText } from "../workspace/sourceFile";

/**
 * The system prompt as Pi sections, most stable first. Pi stores each section as a
 * positional system entry and re-sends only the sections that changed, so the editor
 * context can follow the cursor without invalidating the provider's prompt cache for
 * the rules and project instructions before it.
 */
export function systemPromptSections(options: {
  workspace: AcodeWorkspace;
  settings: () => AgentSettings;
  extensions: ExtensionRegistry;
  skills: () => readonly Skill[];
}): PromptSection[] {
  const { workspace, settings, extensions, skills } = options;
  return [
    section("preamble", () => preamble(workspace), { tag: false }),
    section("project_instructions", () => projectInstructions(workspace)),
    section("available_skills", () => skillCatalog(skills()), { tag: false }),
    section("plugin_context", () => pluginContext(extensions)),
    section("editor", () => editorContext(workspace, settings())),
  ];
}

export function preamble(workspace: AcodeWorkspace): string {
  return [
    "You are Acode's in-editor coding agent, powered by the Pi agent runtime.",
    "Work autonomously toward the user's requested outcome and use tools to inspect evidence before guessing.",
    "File-tool paths are POSIX and workspace-relative; never pass device paths, absolute paths, or URIs.",
    "Read open buffers before editing. Edits to open files remain unsaved so the user retains editor undo/save control.",
    "Prefer edit for focused changes and write for new files or deliberate whole-file rewrites.",
    "Never expose credentials, provider keys, hidden workspace URIs, or private values in tool results or responses.",
    `Workspace: ${workspace.info.name}. Storage: ${workspace.info.remote ? "remote; keep walks bounded and sequential" : workspace.info.scheme}.`,
    "Use web_search for current docs, APIs, package versions, and recent events instead of guessing. Follow with fetch_content when you need the full page. Cite source URLs.",
    "For 3+ step work, keep a live checklist with todo_write. Do not paste it into chat.",
    "When a decision is underspecified, ask with ask_user_question instead of guessing.",
    "For broad searches or reading many files, delegate to subagent (explore) so only its report enters your context. Run independent subagents in the same turn to work in parallel.",
  ].join("\n\n");
}

/** AGENTS.md wins; CLAUDE.md covers projects set up for Claude Code. */
async function projectInstructions(workspace: AcodeWorkspace): Promise<string | undefined> {
  for (const file of ["AGENTS.md", ".agents.md", "CLAUDE.md"]) {
    try {
      const instructions = await workspace.readText(file);
      return `From ${file}:\n${instructions.slice(0, 32_000)}`;
    } catch {
      // Optional project instructions.
    }
  }
  return undefined;
}

function editorContext(workspace: AcodeWorkspace, settings: AgentSettings): string | undefined {
  const sourceFile = resolveSourceFile();
  if (!sourceFile) return undefined;
  const relative = workspace.sandbox.relative(sourceFile.uri);
  if (relative === undefined) return undefined;
  const lines = [`Active editor file: ${relative}`];
  if (settings.includeSelection) {
    const selected = selectedText(sourceFile);
    if (selected) lines.push(`Current selection from ${relative}:\n${selected.slice(0, 12_000)}`);
  }
  return lines.join("\n\n");
}

async function pluginContext(extensions: ExtensionRegistry): Promise<string | undefined> {
  const parts: string[] = [];
  for (const source of extensions.contextSources) {
    try {
      const value = await source();
      if (value) parts.push(value);
    } catch (error) {
      console.warn("AI context contribution failed", error);
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

export function skillCatalog(skills: readonly Skill[]): string | undefined {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (!visible.length) return undefined;
  const rows = visible.map((skill) =>
    [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      "  </skill>",
    ].join("\n"),
  );
  return [
    "The skills below have already been discovered from project and configured global Pi skill roots.",
    "Treat this catalog as the source of truth for skill access. Do not list .agents/.pi or search for SKILL.md to check access; global skills are intentionally outside workspace file tools.",
    "When a task matches, call load_skill directly with its listed name. Use load_skill's optional path for referenced files.",
    "<available_skills>",
    ...rows,
    "</available_skills>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
