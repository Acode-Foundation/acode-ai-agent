# Acode AI Agent

A coding agent for [Acode](https://acode.app). It opens as an editor tab, reads and edits your project, searches the web, and runs shell commands on Terminal-backed folders. You connect your own model provider.

The agent core comes from [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-durable` and `@earendil-works/pi-ai` 1.0.4): providers, durable sessions, compaction, queues, retries, and the `read`, `write`, `edit` and `bash` tools. This plugin adds the Acode side: the editor UI, the workspace sandbox, approvals, and everything needed to run in an Android WebView without Node.

If you use Pi on a desktop, most of it carries over:

- Providers, models, thinking levels, API-key and device-code login
- Durable runs. Each model turn and tool call is saved before it is shown, so a run that Android interrupts can resume.
- Branches, compaction, steer and follow-up queues, fork, clone, `/tree`
- Skills and prompt templates (`.pi/skills`, `.agents/skills`, `/skill:name`, `load_skill`)
- Project instructions from `AGENTS.md` or `CLAUDE.md`
- Import and export of Pi CLI session files (JSONL)

What differs: files go through Acode's `fsOperation` (local, SAF, FTP, SFTP), `bash` only exists on Terminal-backed folders, and OAuth uses a custom tab with device approval or an app callback instead of a localhost server. Pi packages, tmux and the Pi TUI are not included.

## Requirements

- Acode version code 1002 or newer
- An open project folder (local, SAF, FTP or SFTP)
- An API key or subscription for a supported provider

There is no backend. Requests go straight to the provider you connect.

## Install

From the plugin store: **Settings → Plugins**, search for **Acode AI Agent**, install and enable it.

From a zip: run `npm run build` (or download a release), then **Settings → Plugins → + → LOCAL** and pick `plugin.zip`.

## Getting started

1. Open a project folder in Acode. The agent only works inside that folder.
2. Open the agent from the **AI Agent** sidebar app or the command palette (**AI Agent: Open**).
3. Tap **⋯** (top right) and add a provider. If you're not sure which, an [OpenRouter](https://openrouter.ai) API key covers many models with one key.
4. Tap the chip in the composer (for example `Ask · Med · <model>`) to set:
   - **Permission mode.** Start with **Ask** so you approve every edit, delete and command.
   - **Thinking level.** Higher thinks longer and costs more. **Med** is a sensible default.
   - **Model.**
5. Ask for something. An empty chat offers starter prompts like **Map the project** and **Review the open file**.

Acode commands:

| Command                        | What it does                                 |
| ------------------------------ | -------------------------------------------- |
| `AI Agent: Open`               | Open the agent tab                           |
| `AI Agent: New conversation`   | Start a session in the current folder        |
| `AI Agent: New Random project` | Create a starter project in Home and open it |

Sessions are stored per project. The sidebar lists and searches them and can open one in its own tab.

## Using it

**Asking well**

- Say what to change and how you'll know it's done ("disable the button while saving").
- Mention files with `@` (e.g. `@src/app.js`) so the agent doesn't have to look for them.
- For larger changes, ask for a plan first ("plan this, don't edit yet"), then tell it to go ahead.
- One task per chat. Tap **+** when you switch topics.

**During a run**

- The work log shows each step as it happens. Tap a finished step to see its details.
- **Stop** ends the run. Sending a message mid-run steers it; **Queue follow-up** holds a message until the run finishes.
- When it's done the log collapses to "Worked for …". Tap it to look back.

**Reviewing changes**

- In **Ask** mode, each edit shows the removed (`−`) and added (`+`) lines before you approve.
- Edits to files that are open in Acode stay unsaved, so you can read them and use undo before saving.
- After a turn, a card lists the changed files with line counts. **Undo** restores them to their state before that turn and deletes files the turn created. If a file changed again since, it asks first. Moves, deletes and `bash` commands are not undone.

**Context and cost**

- The ring in the composer shows how full the model's context window is. Run `/compact` to summarize older turns, or start a new chat.
- Your provider bills usage. `/session` shows this chat's totals.

**Troubleshooting**

- **"Open a folder first"**: open a project folder in Acode's sidebar.
- **Empty or failed response**: try another model or a lower thinking level.
- **No `bash` tool**: commands only run on Acode Terminal folders. Elsewhere the agent can edit files but not run them.
- **"Run interrupted"**: Android stopped the app mid-run. **Resume** continues from the last saved step; **Discard** drops it.

## Providers

Add credentials under **Provider access**. Keys and tokens are kept in Acode's plugin secure storage, never in settings, chat history or tool output.

**API key:** OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek, Cerebras, Fireworks, Together, Moonshot / Kimi, MiniMax, Z.AI, Kimi Coding, Qwen Token Plan, Ant Ling, Xiaomi.

**Subscription sign-in:**

| Provider       | Account               |
| -------------- | --------------------- |
| OpenRouter     | OpenRouter account    |
| Codex          | ChatGPT Plus / Pro    |
| GitHub Copilot | Copilot subscription  |
| xAI            | Grok / X subscription |
| Kimi Code      | Kimi Code             |

- **OpenRouter** opens a custom tab and connects when you approve. No code to paste.
- **Codex, xAI and Kimi Code** use device codes: tap **Copy code & sign in**, paste the code on the provider's page and approve. For Codex, first enable device-code authorization in ChatGPT under Settings → Security.
- **GitHub Copilot** uses github.com by default. **Other sign-in options** accepts an Enterprise domain.

Anthropic is API-key only. Anthropic doesn't allow third-party apps to use Claude subscription sign-in, so Claude Pro / Max login was removed. If you used it before, add a Console API key.

**Custom models and local servers**

- In the model picker, paste any model id the provider accepts (e.g. `anthropic/claude-sonnet-4.6` on OpenRouter) to use a model missing from the catalog.
- **Provider access → Local endpoint** adds an OpenAI-compatible server such as llama.cpp, vLLM, LM Studio or Ollama. Set the base URL (e.g. `http://192.168.1.10:8080/v1`), list model ids or fetch them from `/models`, and mark whether they accept images or reasoning. Up to 20 endpoints.
- `/scoped-models` chooses which models this agent offers.

## Tools

**Workspace** (any open folder)

| Tool       | Does                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `read`     | Read text or images (`jpg`, `png`, `gif`, `webp`, `bmp`). Unsaved editor content wins. Long files page with `offset` / `limit`. |
| `list_dir` | List a folder, 500 entries per call by default (max 2000)                                                                       |
| `grep`     | Text or regex search with an optional file glob, 100 matches by default (max 1000)                                              |
| `glob`     | Find files by pattern, 200 by default (max 1000)                                                                                |
| `write`    | Create or replace a file                                                                                                        |
| `edit`     | Exact text replacements in a file                                                                                               |

Results that are cut off say so and explain how to get the rest. `grep` and `glob` also name any folders they skipped.

**How `edit` works.** One call can make several replacements, each an exact `oldText` → `newText`. Each `oldText` must match exactly one spot in the file, and replacements can't overlap. Small whitespace and curly-quote differences are tolerated. Line endings and a UTF-8 BOM are kept. Older `old_string` / `new_string` calls still work.

If the file is open in Acode, `edit` and `write` change the editor buffer and leave it unsaved. Otherwise they write to disk. Each change gets a diff card in the work log.

**Shell** (Acode Terminal folders only)

`bash` streams output, supports timeout and cancel, and starts in the project folder. It isn't available on SAF, local storage, FTP or SFTP folders because the Terminal can't reach those paths.

**File operations** (folders without `bash`)

So refactors can still move things around, these work on every folder type:

- `move_path`: move or rename to a new path, creating missing parent folders
- `rename_path`: rename in place, including case-only renames
- `copy_path`: copy a file or folder; open files are copied from the editor
- `delete_path`: delete a file, or a folder with `recursive: true`
- `create_directory`: create a folder and its parents

None of them overwrite an existing path. Open tabs follow moves and renames. A deleted file's tab stays open as an unsaved buffer, the same as deleting from Acode's file browser.

**Web**

- `web_search` uses the provider's built-in search on OpenAI, Codex, Google Gemini, xAI and Anthropic (API key), and falls back to the device browser otherwise.
- `fetch_content` fetches a public page as markdown. GitHub file links are fetched raw. Local and private addresses are blocked.

**Subagents**

`subagent` hands a self-contained task to a child agent with its own context and returns only its report. `explore` (default) can only read and search; `general` can also edit and run commands.

- Several subagents in one turn run in parallel. Each appears in the work log with live progress and its own **Stop**.
- Subagents can't start subagents, ask you questions or edit the task list. Their edits still need approval, labeled "Subagent".
- Stopping the run stops them, and a resumed run picks them back up. After 30 model turns a subagent is told to wrap up.

**Other**

- `todo_write`: a checklist for multi-step work
- `ask_user_question`: ask you to pick between options instead of guessing
- `load_skill`: load a skill into context

## Permissions

Set from the composer:

| Mode            | Behavior                                                          |
| --------------- | ----------------------------------------------------------------- |
| **Ask**         | Approve every edit, delete and terminal command                   |
| **Allow edits** | Writes, moves and copies run freely; deletes and `bash` still ask |
| **Full access** | Nothing asks                                                      |

An approval prompt can also allow that kind of action for the rest of the session. Edits, deletes and commands are allowed separately, and the grants reset on a new, forked or cloned session.

**Full access** means the agent can write and delete files and, on Terminal folders, run any command without asking.

## Composer

- `/` for slash commands, `@` to mention a file
- Attach images or files from the device
- Large pastes collapse into chips
- `Ctrl/⌘ + Enter` sends (or steers a running turn); `Ctrl/⌘ + Shift + Enter` queues a follow-up
- On a phone, Enter adds a newline; use the send button

The agent also sees the active file and, if enabled, the current selection.

## Instructions, skills and prompts

**Project instructions.** The first of `AGENTS.md`, `.agents.md` or `CLAUDE.md` in the folder root is added to the system prompt (up to 32,000 characters). `AGENTS.md` wins if there are several.

**Skills** are folders containing a `SKILL.md` with `name` (lowercase letters, digits, hyphens) and `description` front matter. They're found in `.agents/skills/` and `.pi/skills/`.

```md
---
name: review-pr
description: Review the current changes like a code reviewer.
---

Focus on bugs, missing tests, and API breakage. Do not rewrite style-only issues.
```

**Prompt templates** are markdown files in `.agents/prompts/` or `.pi/prompts/`. Each becomes a slash command.

**Global skills** come from a folder added under **Pi settings → Add global skills folder**, plus `.agents/skills` and `.pi/agent/skills` in Acode's data storage. A project skill wins over a global one with the same name. `/reload` rescans; `/skill:name` runs a skill when skill commands are enabled.

## Slash commands

| Command            | Action                                          |
| ------------------ | ----------------------------------------------- |
| `/model`           | Choose the model for this session               |
| `/scoped-models`   | Choose which models this agent offers           |
| `/settings`        | Open Pi settings                                |
| `/login` `/logout` | Manage provider credentials                     |
| `/resume`          | List sessions                                   |
| `/new`             | Start a new session                             |
| `/compact`         | Summarize older context                         |
| `/name`            | Rename this session                             |
| `/session`         | Show usage and session info                     |
| `/tasks`           | Show the task list (`clear`, `clear-completed`) |
| `/tree`            | Branch from an earlier point                    |
| `/fork`            | New chat from before a user message             |
| `/clone`           | Copy the current branch into a new chat         |
| `/copy`            | Copy the latest reply                           |
| `/export`          | Export as Pi CLI session JSONL                  |
| `/import`          | Import a Pi CLI session (`.jsonl`)              |
| `/reload`          | Reload skills and prompts                       |
| `/hotkeys`         | Show composer shortcuts                         |

Project prompts and `/skill:name` commands are added once they load.

## Workspaces

The agent only sees paths relative to the project root. Device URIs, absolute paths, `..` and remote URLs with credentials are rejected and never reach the model.

| Folder type               | Files              | `bash`                      |
| ------------------------- | ------------------ | --------------------------- |
| Local / Acode Terminal FS | yes                | yes, if Executor is present |
| SAF `content://`          | yes                | no (file operation tools)   |
| FTP / SFTP                | yes, bounded walks | no (file operation tools)   |

Folder walks on remote storage are sequential and capped (200 files by default, fewer for FTP/SFTP search).

## Privacy and storage

- Absolute paths, URI schemes, `..`, backslashes and null bytes are rejected, and workspace URIs never appear in tool output or the transcript.
- Credentials use Acode's plugin secret storage. On hosts without it, they stay in memory only.
- Chats live in the WebView's IndexedDB, one Pi session per chat. Deleting a chat deletes its data. Keys and tokens are redacted before anything is saved.
- `fetch_content` refuses localhost, private networks and URLs with embedded credentials.
- A run keeps going when the app is in the background. If Android kills the app, the chat offers to resume from the last saved step.

## Extension API

Other Acode plugins can extend the agent once it has loaded:

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

- `registerTool` takes a Pi durable tool (`defineTool` from `@earendil-works/pi-durable`, with `execute(args, api, context)`). It applies to running chats immediately.
- `registerProvider` takes a Pi provider. Open sessions pick it up.
- `registerContext` adds a section to the system prompt, rebuilt before each request and re-sent only when it changes.
- `registerFeature` only records metadata for now and isn't shown in the UI.

Each `register*` call returns a function that unregisters it. Tools have to come from another Acode plugin; the agent never evaluates project JavaScript.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` typechecks, bundles for Chrome 90 WebView, rejects Node imports, enforces a 2.5 MB limit on `dist/main.js`, and writes `plugin.zip`.

`npm run dev` serves on port 3000 and rebuilds on change for plugin reload.

The code must stay WebView-compatible: no Node built-ins, child processes, IPC or process `cwd`.

## License

MIT. See [LICENSE](LICENSE).
