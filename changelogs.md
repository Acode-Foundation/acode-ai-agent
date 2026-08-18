# 1.0.0

- Switched chats from a raw Pi `Agent` plus a localStorage message array to Pi `AgentHarness` and a persisted session tree.
- Added auto-compaction near the context limit, plus visible steer and follow-up queues.
- Added the remaining portable Pi API-key providers. Node-only backends such as Bedrock and Vertex stay out of the WebView bundle.
- Added Grok 4.6 and per-model effort levels, so Grok no longer shows unsupported `xhigh` / `max` controls on older Grok models.
- Added a portable in-process Pi agent runtime.
- Added six API-key providers, Codex and Grok/X subscription sign-in, and searchable model selection.
- Added URI-safe Acode workspace tools with dirty-buffer support.
- Added guarded edits, persistent sessions, Acode-secured API/OAuth credentials, and a mobile-first Preact editor UI.
- Added provider, tool, context, and feature extension registries for future agent capabilities.
- Added a purpose-built π field-agent plugin icon.
