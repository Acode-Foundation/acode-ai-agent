# Acode AI Agent

A mobile-first coding agent that runs directly inside an Acode editor page. It uses the Pi runtime (`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`) without requiring Node.js, a daemon, IPC, sockets, a terminal process, or a real filesystem cwd.

## What works

- Streaming, provider-neutral Pi agent loop in the Android WebView
- OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, and the other portable Pi API-key providers
- ChatGPT Plus/Pro (Codex) and Grok/X subscription sign-in through portable device-code OAuth
- Pi `AgentHarness` session trees with auto-compaction, steer, and follow-up queues
- Local files, SAF `content://`, FTP, and SFTP workspaces through Acode `fsOperation`
- Dirty editor-buffer reads and unsaved buffer edits
- `read_file`, `list_dir`, `grep`, `glob`, `write_file`, and exact `edit_file` tools
- Pi-style streaming `bash` with timeout/cancellation, exposed only for Acode Terminal-backed workspaces
- One guarded edit approval surface with an optional session-wide edit grant
- Project `AGENTS.md`, active-file, and selection context
- Workspace-scoped conversation persistence with key-shaped text redaction
- Acode plugin-scoped secure storage for provider credentials

The agent keeps shell support optional. Core file workflows have no shell dependency; `bash` is registered only when the active folder is backed by Acode Terminal's own filesystem and the Executor bridge is available.

## Architecture

```text
Preact editor UI
      │
AgentController ── extension registries (providers, tools, context, features)
      │
AgentSession ── Pi AgentHarness + session tree + Pi Models
      │
AcodeWorkspace ── PathSandbox ── fsOperation / editor buffers
      │
MutationGate + Acode secure credential adapter
```

The runtime boundary is explicit: Pi knows nothing about Acode URIs, and the Acode adapter knows nothing about provider-specific agent logic. This keeps future additions—sub-agents, skills, MCP-style connectors, planners, or background jobs—from forcing a chat/session rewrite.

## Extension API

After the plugin initializes:

```js
const runtime = acode.require("acode.ai.agent.runtime");

const unregister = runtime.registerTool(myPiAgentTool);
runtime.registerContext("my-plugin:context", async () => "Extra project context");
runtime.registerProvider(myPiProvider);
runtime.registerFeature({
  id: "my-plugin:subagents",
  label: "Sub-agents",
  description: "Delegate bounded work",
  available: ({ workspace }) => Boolean(workspace),
});
```

Tools registered after a session starts are applied to the live Pi agent immediately. Context contributions are rebuilt before every user turn.

## Security model

- Tool paths must be workspace-relative POSIX paths. Absolute paths, URI schemes, `..`, backslashes, and null bytes are rejected.
- Absolute workspace URIs never enter tool results or UI activity. This prevents credential-bearing SFTP URLs from reaching the model.
- API keys and OAuth refresh credentials use `PluginContext.getSecret/setSecret`, backed by Acode's plugin-scoped secure storage.
- Keys are never written to local storage, settings, session history, logs, or tool results. A non-Acode host gets an in-memory-only credential adapter.
- Writes and edits are sequential and gated. Open files are changed in the editor buffer and are not auto-saved.
- Terminal commands are sequential and approval-gated unless the session uses full-access mode. The tool is absent for ordinary SAF, local-storage, FTP, and SFTP workspaces.
- Transport is pinned to HTTP SSE; the runtime does not require WebSockets.

## Provider subscriptions

Codex and xAI subscription adapters use one-time device codes and ordinary HTTPS polling. They do not start a localhost callback server or require Node, IPC, sockets, a terminal, or access to the user's provider password. The resulting OAuth credential is stored through Acode's secure plugin context. Further browser-compatible auth methods can be added through the provider registry without changing the runtime, tools, sessions, or UI foundation.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` emits `plugin.zip`, rejects external runtime imports, and enforces a 1.65 MB mobile bundle budget.
