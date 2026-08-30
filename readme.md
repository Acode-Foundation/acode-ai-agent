# Acode AI Agent

A coding agent that runs inside [Acode](https://acode.app) as an editor tab. It can read the open project, search files, propose edits, search the web, and — on Terminal-backed workspaces — run shell commands. You bring your own model provider.

## Built on Pi

This is not a from-scratch agent. The model loop, providers, sessions, skills, compaction, and tool calling come from [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 0.83.0). This plugin is the Acode/Android host: editor UI, workspace sandbox, approvals, and anything that has to work in a WebView without Node.

If you already use Pi on a desktop, the same ideas apply here:

- Providers, models, thinking levels, and device-code / API-key login
- Session trees, compaction, steer / follow-up queues, fork, clone, `/tree`
- Skills and prompt templates (`.pi/skills`, `.agents/skills`, `/skill:name`, `load_skill`)
- Project instructions from `AGENTS.md`
- Import / export of Pi JSON and JSONL sessions

What Pi’s desktop CLI does with a real terminal, cwd, and Node is adapted for Acode: files go through `fsOperation` (local, SAF, FTP, SFTP), `bash` exists only on Terminal-backed folders, and OAuth uses device codes instead of a localhost callback. Pi packages, tmux, and the Pi TUI are not part of this plugin.

## Requirements

- Acode with version code **1002** or newer
- An open project folder (local, SAF, FTP, or SFTP)
- An API key or subscription from a supported provider

The plugin does not run a cloud backend. Inference happens through the provider you connect. There is no Node.js, daemon, or localhost callback server.

## Install

**From the Acode plugin store**

1. Open **Settings → Plugins**.
2. Search for **Acode AI Agent**.
3. Install, then enable the plugin.

**From a zip**

1. Build `plugin.zip` with `npm run build`, or download a release zip.
2. Open **Settings → Plugins → + → LOCAL** and pick the zip.

## Get started

1. Open a project folder in Acode.
2. Open the agent from any of:
   - the **AI Agent** sidebar app
   - command palette → **AI Agent: Open**
   - plugin settings → **Open AI Agent**
3. Tap the overflow menu and add a provider credential.
4. Ask it to inspect the project, edit a file, or review the open buffer.

The agent needs a folder. Without one, tools have no sandbox.

**Commands registered with Acode**

| Command | What it does |
| --- | --- |
| `AI Agent: Open` | Opens the agent tab |
| `AI Agent: New conversation` | Starts a new session in the current folder |
| `AI Agent: New Random project` | Creates a starter project under Home and opens it |

Sessions are stored per project. The sidebar lists them, can search them, and can open a session in a dedicated tab.

## Providers

Pick a provider in **Provider access**. Keys and OAuth tokens go into Acode plugin-scoped secure storage, not settings JSON, session history, or tool results.

**API key**

OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Cerebras, Fireworks, Together, Moonshot / Kimi, MiniMax, Z.AI, Kimi Coding, Qwen Token Plan, Ant Ling, Xiaomi.

**Subscription / device-code sign-in**

| Provider | Sign-in |
| --- | --- |
| OpenRouter | OpenRouter account |
| Codex | ChatGPT Plus / Pro |
| Anthropic | Claude Pro / Max |
| GitHub Copilot | Copilot subscription |
| xAI | Grok / X subscription |
| Kimi Coding | Kimi Code |

## What it can do

**Workspace tools** (always available in an open folder)

- `read_file` — text or images (`jpg`, `png`, `gif`, `webp`, `bmp`); dirty editor buffers are the source of truth
- `list_dir`, `grep`, `glob`
- `write_file` and exact `edit_file`

**Web**

- `web_search` — live search (provider search when available, otherwise the device browser)
- `fetch_content` — public `http(s)` pages as markdown; GitHub blob URLs are rewritten to raw files; local/private hosts are blocked

**On Acode Terminal workspaces only**

- `bash` — streaming command with timeout and cancel, cwd already set to the terminal project
- Not registered for ordinary SAF, local-storage, FTP, or SFTP folders, because Alpine cannot address those Acode paths

**Session extras**

- `todo_write` — compact checklist for multi-step work
- `ask_user_question` — structured choices instead of guessing
- `load_skill` — load a discovered skill into context

Completed `edit_file` / `write_file` calls show a CodeMirror diff card in the work log. That is a per-tool preview, not a session-wide review tray.

## Permissions

Three modes, from the composer:

| Mode | Behavior |
| --- | --- |
| **Ask** | Approve each edit and each terminal command |
| **Allow edits** | Workspace writes this session; still ask for `bash` |
| **Full access** | Skip those prompts |

Approvals can also be granted for the rest of the session from the prompt itself (`Allow for session`). Session grants reset on a new/forked/cloned session.

## Composer

- Type `/` for slash commands, `@` for workspace file mentions
- Attach images or files from the device
- Large pastes collapse into chips
- Send steers the current run; queue a follow-up for after it finishes
- Hardware shortcuts: `Ctrl/⌘ + Enter` send/steer, `Ctrl/⌘ + Shift + Enter` queue follow-up
- On a phone, software Enter is a newline; the send button submits

The agent also sees the active file and, if enabled, the current selection.

## Skills, prompts, and project instructions

**Project instructions** — if the folder contains `AGENTS.md` or `.agents.md`, that file is added to the system prompt (first 32 KB).

**Skills** are folders with a `SKILL.md` front matter of `name` (lowercase letters, digits, hyphens) and `description`. Discovered automatically from:

- `.agents/skills/`
- `.pi/skills/`

**Prompt templates** are markdown files in `.agents/prompts/` or `.pi/prompts/`. They become slash commands.

**Global skills** can be added from **Pi settings → Add global skills folder**. Acode data storage `.agents/skills` and `.pi/agent/skills` are also scanned.

Project skills win when names collide with global ones. `/reload` refreshes the list. `/skill:name` runs a skill when skill commands are enabled.

Example skill:

```md
---
name: review-pr
description: Review the current changes like a code reviewer.
---

Focus on bugs, missing tests, and API breakage. Do not rewrite style-only issues.
```

## Slash commands

| Command | Action |
| --- | --- |
| `/model` | Choose the model for this session |
| `/settings` | Open Pi settings |
| `/login` `/logout` | Provider credentials |
| `/resume` | Session list |
| `/new` | Fresh session |
| `/compact` | Summarize older context |
| `/name` | Rename this session |
| `/session` | Usage and identity |
| `/tasks` | Task list (`clear`, `clear-completed`) |
| `/tree` | Jump to an earlier point |
| `/fork` | Fork from a user message |
| `/clone` | Clone the active branch |
| `/copy` | Copy the latest assistant reply |
| `/export` | Show portable JSON (copy from the sheet) |
| `/import` | Import a Pi JSON / JSONL session |
| `/reload` | Reload skills and prompts |
| `/hotkeys` | Composer shortcuts |

Project prompts and `/skill:name` are added to this list when they load.

## Workspaces

The agent talks in workspace-relative POSIX paths. Device URIs, absolute paths, `..`, and credential-bearing remote URLs are rejected and never sent to the model.

| Folder type | Files | `bash` |
| --- | --- | --- |
| Local / Acode Terminal FS | yes | yes, if Executor is present |
| SAF `content://` | yes | no |
| FTP / SFTP | yes, bounded walks | no |

Remote walks stay sequential and capped (default 200 files, lower on FTP/SFTP search).

## Security

- Paths go through `PathSandbox`. Absolute paths, URI schemes, `..`, backslashes, and null bytes are rejected.
- Workspace URIs never appear in tool results or the transcript.
- Provider secrets use `PluginContext.getSecret` / `setSecret`. A host without that API keeps credentials in memory only.
- Writes are sequential and gated. Open files stay unsaved until you save them.
- `fetch_content` refuses localhost, private networks, and URLs with embedded credentials.
- Backgrounding the app aborts the current run.

Treat **Full access** as a real grant: the agent can write files and, on Terminal workspaces, run commands.

## Extension API

Other Acode plugins can extend the agent after it initializes:

```js
const runtime = acode.require("acode.ai.agent.runtime");

runtime.registerTool(myPiAgentTool);
runtime.registerProvider(myPiProvider);
runtime.registerContext("my-plugin:context", async () => "Extra project context");
runtime.registerFeature({
  id: "my-plugin:feature",
  label: "Feature",
  description: "Declared capability",
  available: ({ workspace }) => Boolean(workspace),
});
runtime.open();
runtime.selectProvider("openrouter");
```

- `registerTool` — Pi `AgentTool`. Tools registered after a session starts are applied immediately.
- `registerProvider` — Pi provider. Live sessions pick it up.
- `registerContext` — extra system-prompt text, rebuilt before every user turn.
- `registerFeature` — metadata only in 0.1.0; it is **not** shown in the UI yet.
- Never evaluate arbitrary project JavaScript in the WebView. Cross-plugin tools must come from another Acode plugin.

Unregister by calling the function returned from `registerTool` / `registerContext` / `registerProvider`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` typechecks, bundles a Chrome 90 / WebView IIFE, rejects Node runtime imports, enforces a 1.92 MB `dist/main.js` budget, and writes `plugin.zip`.

```sh
npm run dev
```

Serves and watches on port 3000 for plugin reload during development.

The runtime stays browser/WebView-compatible: no Node built-ins, child processes, IPC, or a real process `cwd`.

## License

MIT. See [LICENSE](LICENSE).
