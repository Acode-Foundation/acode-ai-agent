# Acode AI Agent

A coding agent that runs inside [Acode](https://acode.app) as an editor tab. It can read the open project, search files, propose edits, search the web, and — on Terminal-backed workspaces — run shell commands. You bring your own model provider.

## Built on Pi

This is not a from-scratch agent. The model loop, providers, sessions, skills, compaction, and tool calling come from [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 0.87.1). This plugin is the Acode/Android host: editor UI, workspace sandbox, approvals, and anything that has to work in a WebView without Node.

If you already use Pi on a desktop, the same ideas apply here:

- Providers, models, thinking levels, and device-code / API-key login
- Session trees, compaction, steer / follow-up queues, fork, clone, `/tree`
- Skills and prompt templates (`.pi/skills`, `.agents/skills`, `/skill:name`, `load_skill`)
- Project instructions from `AGENTS.md` (or `CLAUDE.md`)
- Import / export of Pi JSONL sessions

What Pi’s desktop CLI does with a real terminal, cwd, and Node is adapted for Acode: files go through `fsOperation` (local, SAF, FTP, SFTP), `bash` exists only on Terminal-backed folders, and OAuth uses device codes or a pasted browser callback instead of running a localhost server. Pi packages, tmux, and the Pi TUI are not part of this plugin.

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

| Command                        | What it does                                      |
| ------------------------------ | ------------------------------------------------- |
| `AI Agent: Open`               | Opens the agent tab                               |
| `AI Agent: New conversation`   | Starts a new session in the current folder        |
| `AI Agent: New Random project` | Creates a starter project under Home and opens it |

Sessions are stored per project. The sidebar lists them, can search them, and can open a session in a dedicated tab.

## Providers

Pick a provider in **Provider access**. Keys and OAuth tokens go into Acode plugin-scoped secure storage, not settings JSON, session history, or tool results.

**API key**

OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Cerebras, Fireworks, Together, Moonshot / Kimi, MiniMax, Z.AI, Kimi Coding, Qwen Token Plan, Ant Ling, Xiaomi.

**Subscription sign-in**

| Provider       | Sign-in               |
| -------------- | --------------------- |
| OpenRouter     | OpenRouter account    |
| Codex          | ChatGPT Plus / Pro    |
| GitHub Copilot | Copilot subscription  |
| xAI            | Grok / X subscription |
| Kimi Coding    | Kimi Code             |

Anthropic is API-key only. Claude Pro / Max sign-in was removed because Anthropic's policy does not allow third-party apps to use Claude subscription OAuth; use an Anthropic Console API key instead. If you connected Claude Pro / Max in an earlier version, add an API key to keep using Anthropic models.

**Custom models and local endpoints**

- In the model picker, paste any model id the provider accepts (for example `anthropic/claude-sonnet-4.6` on OpenRouter) to use a model that is not in the built-in catalog.
- **Provider access → Local endpoint** adds an OpenAI-compatible server, such as llama.cpp, vLLM, LM Studio or Ollama on your LAN. Set a base URL (e.g. `http://192.168.1.10:8080/v1`), list model ids or fetch them from `/models`, and mark whether the models accept images or reasoning. Up to 20 endpoints.
- `/scoped-models` opens the same picker to choose which models this agent uses.

Codex offers browser sign-in and device-code sign-in. Device-code sign-in connects automatically after approval; first enable device-code authorization in ChatGPT Settings → Security. For browser sign-in, complete ChatGPT sign-in in the browser, then copy the full `http://localhost:1455/auth/callback?...` address and paste it into Acode. The localhost page may show a connection error because Acode does not run a callback server; copying its address completes the sign-in. This browser OAuth flow does not require enabling device-code authorization in ChatGPT settings.

## What it can do

**Workspace tools** (always available in an open folder)

- `read_file` — text or images (`jpg`, `png`, `gif`, `webp`, `bmp`); dirty editor buffers are the source of truth. Long text is paged with `offset` / `limit`.
- `list_dir` — up to 500 entries per call (max 2000), paged with `offset`
- `grep` — plain text or regex, optional file glob; 100 matches by default (max 1000), paged with `offset`
- `glob` — workspace-relative patterns; 200 files by default (max 1000), paged with `offset`
- `write_file` — create a file or replace it entirely
- `edit_file` — targeted replacements (see below)

Truncated results always say so and tell the agent how to continue. `grep` and `glob` also list any folders they skipped, so the agent knows the search was incomplete rather than assuming there were no matches.

**Editing files**

`edit_file` runs Pi's edit tool against the workspace:

- One call can carry several `edits[]`, each an exact `oldText` → `newText` replacement. Each `oldText` must match exactly one place in the original file, and edits must not overlap.
- Matching tolerates small whitespace and typographic-quote differences. Replacement text is inserted literally (`$&`, `$1` are not expanded).
- Line endings (CRLF / LF) and a UTF-8 BOM are preserved.
- Older `old_string` / `new_string` calls still work; they are mapped onto `edits[]`.

If the file is open in Acode, `edit_file` and `write_file` change the editor buffer and leave it unsaved. You keep editor undo and choose when to save. Otherwise the file is written to the workspace.

In **Ask** mode the approval prompt previews each `−` / `+` replacement, or the new file content for `write_file`. After the tool finishes, the work log shows a CodeMirror diff card for that change. The diff card covers one tool call; there is no session-wide review tray.

**Web**

- `web_search` — live search. Uses the provider's native search on OpenAI, Codex, Google Gemini, xAI and Anthropic (API key); other providers, or a failed native search, fall back to the device browser
- `fetch_content` — public `http(s)` pages as markdown; GitHub blob URLs are rewritten to raw files; local/private hosts are blocked

**On Acode Terminal workspaces only**

- `bash` — streaming command with timeout and cancel, cwd already set to the terminal project
- Not registered for ordinary SAF, local-storage, FTP, or SFTP folders, because Alpine cannot address those Acode paths

**File operations** (workspaces without `bash`)

Without a terminal the agent still needs to move, copy, and delete files to finish a refactor. These tools go through `fsOperation`, so they work on SAF, local storage, FTP, and SFTP:

- `move_path` — move or rename a file or folder to a full new path; missing parent folders are created
- `rename_path` — rename in place (`new_name` is a name, not a path); case-only renames work
- `copy_path` — copy a file or folder recursively; binary files are copied byte-for-byte, open files from their editor buffer
- `delete_path` — delete a file, or a folder with `recursive: true`
- `create_directory` — create a folder and its parents

None of them overwrite an existing path. Editor tabs follow a move or rename. A deleted file's tab stays open as an unsaved buffer, like deleting from Acode's file browser. The sidebar tree and Acode's file index are updated too.

**Session extras**

- `todo_write` — compact checklist for multi-step work
- `ask_user_question` — structured choices instead of guessing
- `load_skill` — load a discovered skill into context

## Permissions

Three modes, from the composer:

| Mode            | Behavior                                                                   |
| --------------- | -------------------------------------------------------------------------- |
| **Ask**         | Approve each edit, delete, and terminal command                            |
| **Allow edits** | Writes, moves, and copies without asking; still ask for deletes and `bash` |
| **Full access** | Skip those prompts                                                         |

Approvals can also be granted for the rest of the session from the prompt itself (`Allow for session`). Edits, deletes, and terminal commands are granted separately, and grants reset on a new/forked/cloned session.

## Composer

- Type `/` for slash commands, `@` for workspace file mentions
- Attach images or files from the device
- Large pastes collapse into chips
- Send steers the current run; queue a follow-up for after it finishes
- Hardware shortcuts: `Ctrl/⌘ + Enter` send/steer, `Ctrl/⌘ + Shift + Enter` queue follow-up
- On a phone, software Enter is a newline; the send button submits

The agent also sees the active file and, if enabled, the current selection.

## Skills, prompts, and project instructions

**Project instructions** — the first of `AGENTS.md`, `.agents.md` or `CLAUDE.md` found in the folder root is added to the system prompt (first 32,000 characters). `AGENTS.md` wins when several exist; `CLAUDE.md` covers projects already set up for Claude Code.

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

| Command            | Action                                 |
| ------------------ | -------------------------------------- |
| `/model`           | Choose the model for this session      |
| `/scoped-models`   | Choose models available to this agent  |
| `/settings`        | Open Pi settings                       |
| `/login` `/logout` | Provider credentials                   |
| `/resume`          | Session list                           |
| `/new`             | Fresh session                          |
| `/compact`         | Summarize older context                |
| `/name`            | Rename this session                    |
| `/session`         | Usage and identity                     |
| `/tasks`           | Task list (`clear`, `clear-completed`) |
| `/tree`            | Jump to an earlier point               |
| `/fork`            | Fork from a user message               |
| `/clone`           | Clone the active branch                |
| `/copy`            | Copy the latest assistant reply        |
| `/export`          | Show Pi JSONL (copy from the sheet)    |
| `/import`          | Import a Pi JSONL session              |
| `/reload`          | Reload skills and prompts              |
| `/hotkeys`         | Composer shortcuts                     |

Project prompts and `/skill:name` are added to this list when they load.

## Workspaces

The agent talks in workspace-relative POSIX paths. Device URIs, absolute paths, `..`, and credential-bearing remote URLs are rejected and never sent to the model.

| Folder type               | Files              | `bash`                      |
| ------------------------- | ------------------ | --------------------------- |
| Local / Acode Terminal FS | yes                | yes, if Executor is present |
| SAF `content://`          | yes                | no (file-operation tools)   |
| FTP / SFTP                | yes, bounded walks | no (file-operation tools)   |

Remote walks stay sequential and capped (default 200 files, lower on FTP/SFTP search).

## Security

- Paths go through `PathSandbox`. Absolute paths, URI schemes, `..`, backslashes, and null bytes are rejected.
- Workspace URIs never appear in tool results or the transcript.
- Provider secrets use `PluginContext.getSecret` / `setSecret`. A host without that API keeps credentials in memory only.
- Writes are sequential and gated. Open files stay unsaved until you save them.
- `fetch_content` refuses localhost, private networks, and URLs with embedded credentials.
- Backgrounding the app keeps the current run alive. If the app process is interrupted, the chat offers to resume the durable Pi operation from its last safe checkpoint.

Treat **Full access** as a real grant: the agent can write and delete files and, on Terminal workspaces, run commands.

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

`npm run build` typechecks, bundles a Chrome 90 / WebView IIFE, rejects Node runtime imports, enforces a 2.5 MB `dist/main.js` budget, and writes `plugin.zip`.

```sh
npm run dev
```

Serves and watches on port 3000 for plugin reload during development.

The runtime stays browser/WebView-compatible: no Node built-ins, child processes, IPC, or a real process `cwd`.

## License

MIT. See [LICENSE](LICENSE).
