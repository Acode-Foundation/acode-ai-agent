/**
 * How Acode and this agent work, by topic. Served by `acode_guide` on demand so none of it
 * sits in the system prompt.
 */
export const ACODE_GUIDE: Readonly<Record<string, string>> = {
  overview: [
    "Acode is a code editor for Android built on CodeMirror 6.",
    "- Header: ☰ opens the sidebar, ⋮ opens the main menu. Open files show as tabs (setting openFileListPos: header, sidebar or bottom).",
    "- Sidebar apps: Files (open folders: device storage, SAF, FTP, SFTP), Search (find and replace across the project), Extensions (plugins), Notifications, and apps that plugins add, such as AI Agent.",
    "- Quick tools: the toolbar above the keyboard (Tab, arrows, Ctrl/Shift, search, save, undo, redo). Settings → App settings → Quick tools reorders them.",
    "- Command palette: Ctrl+Shift+P, or the main menu. It runs every command acode_commands lists.",
    "- Useful shortcuts: Ctrl+P find file, Ctrl+F find, Ctrl+R replace, Ctrl+S save, F5 run, Ctrl+, settings, Ctrl+Shift+X plugins, Ctrl+` terminal, Ctrl+Shift+M problems, Ctrl+Alt+F format.",
    "- Docs: https://docs.acode.app. Plugin store: https://acode.app.",
  ].join("\n"),
  settings: [
    "Main menu → Settings, or Ctrl+,. Pages: App settings, Editor settings (Scroll settings inside), Terminal settings, Preview settings, Theme, App icon, Formatter, Plugins, Language servers, Backup/restore, Edit settings (raw settings.json), Restore default settings.",
    "Use acode_settings to find a setting, its current value and where it is; acode_update_settings changes it after the user approves.",
  ].join("\n"),
  run: [
    "Run (▶ in the header, or F5) previews the project: HTML from index.html (or the current file with useCurrentFileForPreview), Markdown as rendered text.",
    "previewMode chooses the in-app browser or the external browser; previewPort and serverPort set the local server ports. The console button in preview opens the debug console (setting console: legacy or eruda).",
    "Acode does not compile other languages itself; run them in the Terminal.",
  ].join("\n"),
  terminal: [
    "The Terminal is Alpine Linux running in proot. Open it from the main menu, Ctrl+`, or the openTerminal command. Install packages with `apk add <name>` (for example nodejs, python3, git, clang).",
    "Folders inside the Terminal's home are Terminal-backed: the agent can run bash there. Device storage, SAF, FTP and SFTP folders cannot be reached from the Terminal.",
    "Settings → Terminal settings: font, cursor, scrollback, theme, backup and restore of the Linux system, and uninstall.",
  ].join("\n"),
  plugins: [
    "Settings → Plugins, or the Extensions sidebar app. Install from the store, from a zip (+ → LOCAL) or a URL; each plugin page has enable, disable, uninstall and its settings.",
    "Plugins add commands, sidebar apps, themes, languages, formatters and settings. A plugin that breaks Acode can be disabled from the Plugins page; disabling applies after a restart.",
    "Use acode_plugins to list installed plugins, search the store, or install one (Acode asks the user to confirm).",
  ].join("\n"),
  themes: [
    "Settings → Theme has the app theme, the editor theme and the terminal theme. With the app theme set to 'system', Acode picks the editor theme to match the device and ignores a chosen one.",
    "Theme plugins from the store add more themes. Custom theme edits the app colors.",
  ].join("\n"),
  lsp: [
    "Settings → Language servers lists servers per language. Installing one runs its install command in the Terminal, so the Terminal must be set up.",
    "Servers work on Terminal-backed folders; allowNonTerminalWorkspace lets them try other folders, with limited features.",
    "Features: completion, diagnostics (Ctrl+Shift+M shows problems), go to definition, references, rename symbol, format document (Alt+Shift+F).",
  ].join("\n"),
  formatting: [
    "Settings → Formatter picks the formatter per language. Prettier is built in for web languages; plugins and language servers add others.",
    "Format with Ctrl+Alt+F, the main menu, or formatOnSave. Indentation comes from softTab and tabSize.",
  ].join("\n"),
  files: [
    "Open a folder from the Files sidebar app (+ Add folder): device storage, SAF storage, FTP or SFTP. Open folders are remembered (rememberFolders).",
    "Long-press a file or folder for new, rename, copy, cut, delete and open with. excludeFolders hides globs from search and scanning.",
    "Unsaved tabs show a dot; Ctrl+S saves, save-all-changes saves every tab; autosave saves after a delay.",
  ].join("\n"),
  agent: [
    "You are the Acode AI Agent plugin. How the user works with you:",
    "- Open: the AI Agent sidebar app, or the command palette (AI Agent: Open, AI Agent: New conversation).",
    "- ⋮ in the agent tab: Provider access (API keys, subscription sign-in, local OpenAI-compatible endpoints) and agent settings.",
    "- The composer chip (e.g. 'Ask · Med · model'): permission mode (Ask approves every edit, delete and command; Allow edits; Full access), thinking level, and model.",
    "- In the composer: @ mentions files, / runs commands and skills (/model, /new, /compact, /tree, /fork, /session, /export, /login, /settings, /hotkeys), the paperclip attaches files and images.",
    "- Under a prompt: Edit reruns it, Fork starts a new chat from it. Under an answer: Retry, Fork. The changed-files card has Undo.",
    "- The ring in the composer shows context use; /compact summarizes older turns. Chats are saved per project and listed in the sidebar.",
    "- bash only works on Terminal-backed folders. Project rules come from AGENTS.md or CLAUDE.md; skills from .agents/skills or .pi/skills.",
  ].join("\n"),
};

export const GUIDE_TOPICS = Object.keys(ACODE_GUIDE);
