# Acode AI Agent

A coding agent for [Acode](https://acode.app). It opens as an editor tab, reads and edits your project, searches the web, and runs shell commands on Terminal-backed folders. You connect your own model provider.

The agent core comes from [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-durable` and `@earendil-works/pi-ai` 1.5.2): providers, durable sessions, compaction, queues, retries, and the `read`, `write`, `edit` and `bash` tools. This plugin adds the Acode side: the editor UI, the workspace sandbox, approvals, and everything needed to run in an Android WebView without Node.

If you use Pi on a desktop, most of it carries over:

- Providers, models, thinking levels, API-key and device-code login
- Durable runs. Each model turn and tool call is saved before it is shown, so a run that Android interrupts can resume.
- Branches, compaction, steer and follow-up queues, fork, clone, `/tree`
- Skills and prompt templates (`.pi/skills`, `.agents/skills`, `/skill:name`, `load_skill`)
- Project instructions from `AGENTS.md` or `CLAUDE.md`
- Import and export of Pi CLI session files (JSONL)

What differs: files go through Acode's `fsOperation` (local, SAF, FTP, SFTP), `bash` only exists on Terminal-backed folders, and OAuth uses Acode's native browser and callback support. Pi packages, tmux and the Pi TUI are not included.

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

In the sidebar, **Spin up new session** suggests a project name. Keep it or enter your own, then confirm to create the folder in Home and start its first session. Cancel dismisses the prompt.

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

**Branching**

- Under each prompt, **Edit** loads it into the composer with its mentions, files, and images, so `@`, attachments, and commands all work. Sending replaces the prompt where it is and reruns from there, keeping the original as an earlier version; **Cancel** puts back whatever you had typed. **Fork** starts a new chat from that prompt.
- Under each answer, **Retry** sends the same prompt again on a new branch, and **Fork** copies the chat up to that answer into a new chat.
- A prompt that was edited or retried shows `‹ 1/2 ›` to switch between its versions; each brings back the rest of its branch.
- Earlier branches also stay in `/tree`, which shows how much context each point carries before you move there. If you ever land on an empty branch, **Restore** brings back the latest messages.

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
| ChatGPT        | ChatGPT Plus / Pro    |
| GitHub Copilot | Copilot subscription  |
| xAI            | Grok / X subscription |
| Kimi Code      | Kimi Code             |

- **OpenRouter** opens a custom tab and connects when you approve. No code to paste.
- **ChatGPT** uses OpenAI's official Sign in with ChatGPT integration. Tap **Continue with ChatGPT**, approve plan usage, then tap **Return to Acode** if needed. On Android, use Chrome for browser sign-in. One ChatGPT account is saved at a time. **Disconnect** signs out; **Remove account** then forgets the saved account so you can connect another. Reconnecting uses the saved registration directly. Use **Manage usage** to review access and limits in ChatGPT. Requests use the public Responses API and your ChatGPT plan allowance.
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

**Codemode**

The `codemode` tool is on by default (**Pi settings → Codemode** turns it off). The agent writes one JavaScript script that calls other tools as `await tools.read({ path })`, so it can run several reads or searches at once, chain them, and filter large results before they reach the model. Only the script's output goes back into the context, which saves model turns and tokens.

- Scripts run in a QuickJS sandbox in a Web Worker: no DOM, network, file system or timers, only the tools. A script that loops forever is stopped by its timeout or **Stop**, and memory is capped at 64 MB.
- The work log shows each script as one card: the tools it called with their results and times, its output, and the script itself.
- Nested calls are validated and approved like direct ones (the prompt says "Codemode"), and edits are covered by **Undo**. Calls made before a script fails are not undone.
- `store()` / `load()` keep small JSON values across scripts in the same chat.
- Subagents, `ask_user_question` and `codemode` itself can't be called from scripts.
- Scripts can run image and classifier models with the chat's credentials through `models` (for example OpenRouter's image models): `models.getAvailableOfType("image")`, `models.generateImages(model, { input })`, `models.classify(model, { state, questions })`. `saveImage(path, image)` writes a generated image into the project after the usual approval. Their cost counts toward the session. OpenRouter needs a credit balance for image output.

**Other**

- `todo_write`: a checklist for multi-step work
- `ask_user_question`: ask you to pick between options instead of guessing
- `tool_search`: load a deferred tool (see below)

**Deferred tools**

Tools the agent seldom needs are not sent with every request: the file operation tools and `ask_user_question`. The system prompt names them, and the agent loads one with `tool_search` when it needs it. A loaded tool stays available on that chat branch until a compaction summarizes away both its loading and its use; then it is hidden again at the next prompt and can be reloaded. Codemode scripts can call deferred tools without loading them. This saves about 740 tokens per request on folders without `bash` and about 180 on Terminal folders.

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

### Sponsored suggestions

Configured builds can show an occasional **Sponsored · Elo** card to users without Acode Pro, after they allow sponsored suggestions. Turn this off in **⋯ → Sponsored suggestions**. Provider subscriptions and API keys do not determine Acode Pro status.

When an eligible ad request is about to start, the current prompt and up to four recent user prompts from the same chat are classified locally, with the newest task taking priority. The ad request contains up to three predefined task topics (for example, “Web development”), never the chat transcript, source code, attachments, tool output, or account details. Elo also receives device/network information and an anonymous advertising identifier. Ads stay outside model context and saved chats. A missing ad or failed network request leaves chat working normally.

The plugin requests a single compact 72px strip, 8px above the message input, and renders the format returned by Elo. It has a thumbnail (or a megaphone icon when missing), title, one description line, a Sponsored label and a separate dismiss control. There is no separate ad below replies. An eligible wait starts the request. The same card stays visible while the answer streams and after the reply finishes, until dismissed, opened or expired. A request already in flight may finish after a fast answer and show that same card. Having text or attachments in the composer hides it to leave more room for writing. Clearing or sending the draft lets the cached card return.

Each chat caches its ad in memory for five minutes from receipt. Later waits reuse that ad. New ads use one shared five-minute view-based cooldown across chats and tabs, with no turn-count requirement. The SDK considers an ad viewed after at least half is visible for one continuous second. Explicit dismissal or a successful link open clears cached ads and suppresses new ads for five minutes, including a quick dismissal before viewability is measured. Consent withdrawal clears the cache. Other failed consent checks may discard a card without starting a new cooldown.

Only an eligible wait can initiate a new request. A long wait can replace an expired card once the cooldown permits it. After a reply finishes, expiry removes the existing card without requesting a replacement. All request attempts share a minimum 30-second interval, including successful requests before an impression is measured. Viewed or explicitly dismissed ads use the longer five-minute cooldown. A different waiting turn resumes automatically after the shared request slot and cooldown become available; the failed turn is not retried. Stopped or failed runs, typing, a chat switch, an obscured conversation or backgrounding cancel pending requests. Restored history alone never initiates requests. Ads are not saved in the transcript.

Free users with device consent see a short opt-in during their first visible wait, with privacy details in an Acode dialog. The opt-in sits above the input and, once at least half visible, stays in that chat until answered. Deleting that chat frees the unanswered offer for another eligible wait. Allowing suggestions makes the current wait eligible immediately. Frequency state lasts for the plugin session. The pinned Elo SDK aborts ad fetches after three seconds, and native consent reads also have a three-second timeout. When upgrading the SDK, run `npm test` and verify the sponsor layout on a device: disclosure placement and failed-image fallback depend on its DOM structure.

## Extension API

Other Acode plugins can extend the agent once it has loaded:

```js
const runtime = acode.require("acode.ai.agent.runtime");

runtime.registerTool(myPiAgentTool);
runtime.registerTool(myRarelyUsedTool, { exposure: "deferred" });
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

- `registerTool` takes a Pi durable tool (`defineTool` from `@earendil-works/pi-durable`, with `execute(args, api, context)`). It applies to running chats immediately. With `{ exposure: "deferred" }` the tool is loaded through `tool_search` instead of sent with every request; use it for large or rarely needed tools.
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

`npm run build` typechecks, bundles for Chrome 90 WebView, rejects Node imports, enforces a 2.7 MB limit on `dist/main.js`, and writes `plugin.zip`.

`npm run dev` serves on port 3000 and rebuilds on change for plugin reload.

The code must stay WebView-compatible: no Node built-ins, child processes, IPC or process `cwd`.

For Elo, copy `.env.example` to the ignored `.env.local` and supply the publisher and Android ad-unit IDs, or set them in the build environment. The iOS ad unit is separate; leave it empty until its App Store property is ready. These are public SDK identifiers. Never ship Elo's server API key. Builds without IDs make no ad requests. The plugin uses Elo’s React-free core. The pinned SDK runs in Acode’s WebView with access to its bridge, DOM and storage. Before updating the SDK, verify that it still reads TCF/GPP synchronously inside `init()`, since the plugin restores shared WebView storage immediately afterward. Review its networking, identifier storage and tracking as well.

For store releases, configure the same public IDs as GitHub Actions variables in the `acode-store` environment. The publish build requires the Android pair. The iOS ID stays optional while the listing is pending.

Elo counts a render when the view mounts and an impression after at least half the view is visible for one continuous second. The plugin disables optional tap telemetry in SDK 0.8.0 because its network retries cannot be cancelled after consent withdrawal. Opening a link still uses the SDK’s consent-checked click notices.

Before releasing, obtain Elo property approval, enable the placement in the dashboard, authorize the seller in the store-listed developer domain's `app-ads.txt`, and update the app's advertising/privacy disclosures. Confirm Elo's support for WebView app inventory and up to three predefined task topics. Before Elo initialization the plugin checks the host’s AdMob privacy state. A host can include an `iabSignals` snapshot in its `privacyGetState` result to supply TCF/GPP values during SDK initialization. The plugin rechecks native consent after initialization and before sending an ad request, before mounting a card, on resume, and before reporting an impression or following a sponsored link. Overlapping checks for the same card share one pending native read. The next interaction after it settles starts a new read. A definite native denial clears the Elo session and its stored identifiers. If the native check is unavailable, the plugin hides the card until consent can be verified. The current host returns only UMP status. An obtained decision needs a native signal snapshot with explicit GDPR applicability and, when applicable, a TC string, and unknown or unavailable native state skips the request. Validate the CMP flow, child-directed settings, and store disclosures with the privacy owner before enabling live inventory.

Verify on a physical device with an Elo-approved test placement: the health and ad requests from Acode’s origin, the render and impression URLs resolving to the SDK origin (`https://api.elo.ad`), image loading, identifier persistence and removal, render, impression and click-notice delivery, and opening and returning from the native browser. Record the WebView version and use test inventory for tracking checks.

Focused checks: `npx vitest run tests/sponsors.test.ts tests/elo.test.ts tests/sponsorUi.test.ts`. Live ad fill, device behavior, and publisher onboarding remain separate release checks.

## License

MIT. See [LICENSE](LICENSE).
