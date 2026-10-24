# 0.4.1

- The Acode tools load the next one you need: looking up a setting makes the update tool ready, finding a command makes running it ready, and the guide readies settings, commands and plugins. The agent no longer fails with "Tool … is not available" when it goes from finding to changing.
- Changing a setting works even when the model guesses the tool's arguments, such as `settings` instead of `changes`, a JSON string, or a plain number.
- Fixed the app theme list showing `[object Object]` and refusing every app theme change. Paid themes are refused without Pro.
- Settings Acode reads without a screen of their own, like `maxFileSize` (in MB), are described and marked as settings.json only. Settings nothing reads anymore are no longer listed.
- Asking for all your settings lists every one, grouped by settings page, instead of stopping after 60.

# 0.4.0

- The agent now knows Acode and can act in it. Ask how to use Acode or this agent, where a setting lives, or to do something in the app, and it reads the live app instead of guessing. Six tools cover it, loaded only when needed so they cost no tokens otherwise:
  - `acode_guide`: how Acode and the agent work, by topic (menus, run and preview, terminal, plugins, themes, language servers, formatting, files).
  - `acode_settings` finds a setting's value, label, page and allowed values; `acode_update_settings` changes settings, including the app and editor themes.
  - `acode_commands` searches every Acode and plugin command with its shortcut; `acode_run_command` runs one.
  - `acode_plugins` lists installed plugins, searches the store (by name, id, keywords or author), shows a plugin's description, and installs one with Acode's own confirmation.
- `acode_ui` operates Acode's screens when no command or setting does the job: it reads the top screen (dialog, menu, phone sidebar, page or editor) as numbered items, including tabs, switches, setting values and store prices, and taps, types and goes back.
- Approvals for Acode changes: changing settings, running commands, and tapping toggles or buttons ask in Ask and Allow edits modes. Destructive taps (delete, uninstall, reset, replace…), confirming a dialog, and typing (except into search boxes) ask every time, even in Full access. Purchases, ads and sponsorship are refused.
- While the agent works out of sight, behind a page, the sidebar or another tab, a small pill says what it is doing and lets you answer an approval in place. Tap it to return to the chat.

# 0.3.0

- Each chat keeps its own provider, model, and thinking level, so chats in different projects or tabs can run on different providers at once, such as two local endpoints. Picking a model changes only the open chat, and new chats start on your latest choice. Existing chats keep the model they last used.
- A branch made from `/tree` runs on the chat's model.
- Switching a chat's model no longer shows the new model the previous model's reasoning as part of its replies.
- Pi packages upgraded to 1.4.0, with better retries for gateway and proxy errors, compaction fixes, and lower memory use in long sessions.
- Fixed a failed `bash` command inside a codemode script losing its output.

# 0.2.1

- Fixed the agent intercepting Acode's own network requests, including login. Agent requests now select their transport without replacing the WebView's global `fetch`.

# 0.2.0

- Codemode: a `codemode` tool, on by default, that runs model-written JavaScript in a QuickJS sandbox and calls the agent's tools from it. Nested calls keep approvals and Undo, and each script shows as one card in the work log with its calls, output and source.
- Fixed `fetch` of the WebView's own files (`https://localhost/...`) failing while the agent was loaded; those requests no longer go through native HTTP.
- Deferred tools: the file operation tools and `ask_user_question` are loaded with a new `tool_search` tool when needed instead of sent with every request, saving about 740 tokens per request on folders without `bash`. Loaded tools are unloaded again after a compaction leaves them unused. Plugins can register tools with `{ exposure: "deferred" }`.
- Edit (through the composer, with Cancel), Retry, and Fork buttons under messages, and a `‹ 1/2 ›` switcher between versions of an edited or retried prompt. An empty branch offers to restore the latest messages.
- Work-log steps show how long they ran, and `/tree` shows the context size at the selected point.
- Codemode scripts can generate images and run classifiers through `models`, and save images into the project with `saveImage()`; their cost counts toward the session.
- The agent now reaches for codemode more often. The system prompt names when to batch (two or more calls with no decision between them), the codemode description leads with that and shows an example, and every tool scripts can call says how. Explore subagents can use codemode for their reads.
- Session tools: `list_sessions` finds chats by title, workspace or the text of recent chats, and `read_session` reads a chat's status, branches, subagents, usage totals and turns, or one turn in full with each tool call's arguments and result. Both are loaded with `tool_search`, callable from codemode, and available to subagents.
- ChatGPT provider: sign in with your ChatGPT Plus or Pro plan through Acode's browser and callback. Disconnect, Remove account and Manage usage are in the provider settings.
- Codex sign-in retries brief network failures while it waits for device approval.
- Fixed tool paths disappearing from the live work log during parallel tool calls.
- `read` refuses folders and times out stalled reads instead of hanging.
- Pi packages upgraded to 1.1.0.

# 0.1.0

First release.

**Agent**

- Coding agent in an Acode editor tab, built on Pi (`pi-durable` and `pi-ai` 1.0.4)
- Durable runs: chats are saved step by step in IndexedDB, and a run interrupted by Android can be resumed or discarded
- Subagents (`explore` and `general`) that run in parallel with their own context
- Per-turn undo for files changed by `write` and `edit`
- Branches, `/tree`, fork, clone, compaction, steering and queued follow-ups
- Project instructions from `AGENTS.md`, `.agents.md` or `CLAUDE.md`, plus skills and prompt templates
- Import and export of Pi CLI sessions (JSONL)

**Tools**

- `read` (text and images), `list_dir`, `grep` (with regex), `glob`, `write` and `edit`
- `bash` on Acode Terminal folders, with a default 120s timeout and cancel
- `move_path`, `rename_path`, `copy_path`, `delete_path` and `create_directory` for SAF, local, FTP and SFTP folders
- `web_search` using the provider's built-in search, with a device browser fallback
- `fetch_content` for public pages, blocking local and private addresses
- `todo_write` task checklist and `ask_user_question`

**Providers**

- API keys for OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, DeepSeek and more
- Subscription sign-in for OpenRouter, Codex, GitHub Copilot, xAI and Kimi Code
- Custom model ids and OpenAI-compatible local endpoints (llama.cpp, vLLM, LM Studio, Ollama)
- Credentials kept in Acode's plugin secure storage

**Interface**

- Ask, Allow edits and Full access permission modes, with per-session grants
- Edit previews before approval and diff cards in the work log
- Live work log with step details and run duration
- Composer with `/` commands, `@` file mentions, attachments and paste chips
- AI Agent sidebar app to browse, search and open sessions per project, and to spin up a random starter project
- Agent actions in the editor selection and terminal menus
