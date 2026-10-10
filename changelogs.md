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
