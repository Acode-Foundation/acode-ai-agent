# TODO

Pre-publish checklist and follow-up work for Acode AI Agent. Priorities: **P0** blocks publishing,
**P1** should land before or right after the first release, **P2** can wait.

## P0 — Blocks publishing

- [ ] **Decide on subscription sign-in.** `src/providers/portableOAuth.ts` reuses first-party
      OAuth client IDs: Codex CLI (ChatGPT) and VS Code Copilot (GitHub). A store-listed plugin
      published as "Acode Foundation" is a far larger target than Pi's personal CLI.
  - [x] Remove Claude Pro/Max sign-in; keep Anthropic via API key.
  - [ ] Review OpenAI (Codex) and GitHub (Copilot) terms before shipping those sign-ins.
  - [x] Update the "Subscription sign-in" table in `readme.md` to match.
  - [ ] Delete the commented-out Anthropic OAuth constants and flow in `portableOAuth.ts` instead of
        shipping them in the source.
- [ ] **Test on real devices.** Recent changes are unit-tested only: `list_dir` stat/timeout fix,
      native-index `grep`, index omission notes, `edit_file` via Pi's edit tool, Pi 0.87.1, and the
      file-operation tools (`move_path`, `rename_path`, `copy_path`, `delete_path`, `create_directory`).
  - [ ] Workspaces: local `file://`, SAF `content://`, Acode Terminal (Alpine), FTP, SFTP.
  - [ ] Acode versions: 1002 (declared `minVersionCode`) and 1011 (current 1.13.5).
  - [ ] Large repo (thousands of files), CRLF files, a file open with unsaved changes.
  - [ ] File operations per backend: SAF `moveTo` across folders, case-only rename on shared
        storage, SFTP `moveTo` (it renames onto the destination folder path), FTP folder delete and
        copy (FTP has no `copyTo`; `copy_path` reads and writes instead), and that the sidebar tree
        and open tabs follow a move.
- [ ] **Write `changelogs.md`.** It only contains `# 0.1.0` and ships in `plugin.zip` / the store listing.

## P1 — Should fix

### Release hygiene

- [ ] **Run `bun run build` in CI** (`.github/workflows/ci.yml`). The bundle budget and the
      external-import guard in `esbuild.config.mjs` are only enforced locally today.
- [ ] **Add a privacy section** to `readme.md` and the store listing: the plugin itself contacts
      `pi.dev` (model catalog), DuckDuckGo/Bing (web search), `raw.githubusercontent.com`
      (`fetch_content`), and the chosen provider, which receives workspace code.
- [ ] **Metadata:** fill `author.email` in `plugin.json`; point `package.json` `repository` at
      `Acode-Foundation/acode-ai-agent` (it points at the main Acode repo); delete the empty local
      `docs/` folder.

### Pi parity — context files

Pi also reads these (pi-coding-agent `docs/configuration.md`); `src/context/contextBuilder.ts`
only reads the workspace-root `AGENTS.md` / `.agents.md` / `CLAUDE.md`.

- [ ] `.pi/SYSTEM.md` — replaces the default system prompt for the project.
- [ ] `.pi/APPEND_SYSTEM.md` — appends project instructions to the system prompt.
- [ ] `AGENTS.override.md` — replaces `AGENTS.md` / `CLAUDE.md` in the same directory.
- [ ] Global `AGENTS.md` (and `SYSTEM.md` / `APPEND_SYSTEM.md`) from the agent directory; reuse the
      configured global skills root (`.pi/agent/`).

## P2 — Later

### Agent features

- [ ] **Review / revert a run's changes.** Open-buffer edits are undoable in the editor; disk
      writes, moves, and deletes are not. Track files touched per run (original content before the
      first write) and offer "revert this run". Makes "Allow edits" safer.
- [ ] **Diagnostics tool.** Acode keeps LSP diagnostics for open files (`src/cm/lsp/diagnostics.ts`
      in the Acode repo, `acode:lsp-diagnostics-updated` event). A `diagnostics` tool would let the
      agent verify edits without a build command. First confirm the plugin API exposes diagnostics:
      `acode.require("lsp")` exposes the LSP API but no documented diagnostics accessor.
- [ ] **Terminal for shared-storage workspaces.** Acode's Alpine sandbox already binds `/sdcard`
      and `/storage` (`src/plugins/terminal/scripts/init-sandbox.sh` in the Acode repo), but
      `resolveTerminalWorkingDirectory` in `src/tools/bash.ts` only maps Acode Terminal paths.
      Map `file:///storage/emulated/0/…`, `/sdcard/…`, and SAF `primary:` trees to their Alpine path,
      probe access once (`test -r`), and fall back to no `bash` when the path is unreadable.
      Do **not** use `Executor.start(…, alpine = false)` (raw Android shell); see Security notes.
- [ ] **Model input limits.** Pi 0.87 ships `model.inputLimits` (e.g. Anthropic: 100 images per
      request, 2000px, 4.5 MB per image) but does not enforce them. `src/platform/promptImages.ts`
      resizes to 2000px but allows up to 8 MB; honor `inputLimits.images` to avoid provider rejections.
- [ ] **Bundle size.** `dist/main.js` is ~2.48 MB against a 2.5 MB budget (about 18 KB left);
      growth is Pi's bundled model catalogs (`pi-ai/dist/providers/data/*.json`). Stub them in the
      build and rely on the runtime catalog (`src/providers/remoteCatalog.ts`) to save several
      hundred KB.
- [ ] **Show new files from `write_file` in the sidebar tree.** The file-operation tools call
      `acode.require("openfolder").add` / `removeItem`; `write_file` does not, so a file it creates
      only appears after the folder is refreshed.

### Pi parity — commands and settings

- [ ] `/export` as HTML (currently JSONL only).
- [ ] `/thinking [level]` slash command (the picker already exists in the composer).
- [ ] `/changelog` showing the plugin's `changelogs.md`.
- [ ] Per-model thinking level memory (Pi `modelThinkingLevels`).
- [ ] Enable/disable individual tools (Pi `defaultTools`).
- [ ] Compaction model override (Pi `compaction.modelOverrides`).

### Not planned

- `/share`, `/bug`, `/quit`, `/llama`, themes, Pi packages, RPC/SDK modes, Pi TypeScript extensions —
  CLI-specific or replaced by the plugin's own extension API.
- MCP, built-in subagents, plan mode — deliberately absent from Pi's core (subagents are being
  explored on the `subagent` branch).

## Done

Already in the plugin; kept here so the list above stays about what is left.

- **Claude Pro/Max sign-in removed.** Anthropic is API-key only; `readme.md` explains the change
  for users who connected a subscription before.
- **Flaky Codex catalog test fixed.** "filters Codex models to the signed-in ChatGPT account
  catalog" stubs `fetch` instead of hitting the network.
- **Readme caught up** with `edit_file` via Pi's edit tool (`edits[]`, CRLF/BOM, tolerant matching),
  `CLAUDE.md` as project instructions, and the `grep`/`glob` notes for skipped folders and paging.
- **Move / rename / copy / delete without a terminal.** On workspaces without `bash` (SAF, local
  storage, FTP, SFTP) the agent gets `move_path`, `rename_path`, `copy_path`, `delete_path`, and
  `create_directory` in `src/tools/fileOperations.ts`, backed by new `AcodeWorkspace` methods
  (`move`, `copy`, `remove`, `createDirectory`). They never overwrite, create missing parents,
  handle case-only renames and name clashes on `moveTo`, re-point open editor tabs (a deleted
  file's tab stays as an unsaved buffer), copy open files from their buffer, fall back to
  child-by-child delete for providers that only remove empty folders, and update Acode's sidebar
  tree and file index. `MutationGate` treats moves, renames, copies, and new folders as edits;
  deletes ask even in "Allow edits", with their own "Allow this session" grant and a preview of
  what goes. Covered by `tests/fileOperations.test.ts`.

## Security notes

- The existing Alpine `bash` runs under Acode's app UID with `/data` bound, so a command can read
  Acode's private storage (settings, sessions, other plugins' data). Keep `bash` approval-required in
  "Allow edits" mode, and consider documenting this next to "Full access" in `readme.md`.
- A raw Android shell (`Executor`, `alpine = false`) would widen this further for little gain:
  toybox has no git/node/python, and SAF `content://` folders are not addressable by path anyway.
