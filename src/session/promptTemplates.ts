/** A Pi skill: a SKILL.md (or root .md) with `name` and `description` frontmatter. */
export type Skill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
};

/** A Pi prompt template: a .md file run as `/name args`. */
export type PromptTemplate = {
  name: string;
  description: string;
  content: string;
};

export type WorkspaceResources = {
  skills: Skill[];
  promptTemplates: PromptTemplate[];
  /** Global skill roots that were scanned. */
  skillRoots: string[];
};

/** Split command arguments like a shell: whitespace separates, quotes group. */
export function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/**
 * Pi's prompt-template substitution: `$1`…`$9` positional arguments, `$@` and
 * `$ARGUMENTS` for all of them, and `${@:N}` / `${@:N:L}` for a slice.
 */
export function expandPromptTemplate(content: string, args: string[]): string {
  const all = args.join(" ");
  return content
    .replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, start: string, length?: string) => {
      const from = Math.max(0, Number(start) - 1);
      return args.slice(from, length === undefined ? undefined : from + Number(length)).join(" ");
    })
    .replace(/\$ARGUMENTS|\$@/g, all)
    .replace(/\$(\d)/g, (_match, index: string) => args[Number(index) - 1] ?? "");
}

/** The user message a `/skill:name args` command sends. */
export function skillInvocation(skill: Skill, args: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>`;
  return args.trim() ? `${block}\n\n${args.trim()}` : block;
}
