import { expect, test } from "vitest";
import { discoverProjectAgents } from "../src/subagents/discovery.ts";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace.ts";

test("discovers project agent markdown and skips skills", async () => {
	const files: Record<string, string> = {
		".pi/agents/audit.md": `---
name: audit
description: Security pass
tools: read, grep
---
Look for unsafe defaults.`,
		".agents/explorer.md": `---
name: scout
description: Project scout override
tools:
  - read
  - ls
---
Stay in src/.`,
		".pi/agents/skip.chain.md": `---
name: chain
description: Not an agent
---
Ignore.`,
	};
	const workspace = {
		async walk(options: { path?: string; onEntry: (entry: { path: string; name: string; isFile: boolean; isDirectory: boolean }) => void }) {
			for (const path of Object.keys(files)) {
				if (options.path && path !== options.path && !path.startsWith(`${options.path}/`)) continue;
				options.onEntry({ path, name: path.split("/").at(-1)!, isFile: true, isDirectory: false });
			}
			return { visited: Object.keys(files).length, truncated: false };
		},
		async readText(path: string) {
			const content = files[path];
			if (!content) throw new Error("not found");
			return content;
		},
		async list() {
			return [];
		},
	} as unknown as AcodeWorkspace;

	const agents = await discoverProjectAgents(workspace);
	expect(agents.map((agent) => agent.name).sort()).toEqual(["audit", "scout"]);
	const scout = agents.find((agent) => agent.name === "scout")!;
	expect(scout.scope).toBe("project");
	expect(scout.tools).toEqual(["read_file", "list_dir"]);
	expect(scout.prompt).toContain("Stay in src/");
});
