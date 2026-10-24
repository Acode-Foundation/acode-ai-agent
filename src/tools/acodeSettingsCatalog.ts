/** Where a setting lives in Acode's UI, so the agent can point the user at it. */
const PAGES = {
  app: "Settings → App settings",
  editor: "Settings → Editor settings",
  scroll: "Settings → Editor settings → Scroll settings",
  preview: "Settings → Preview settings",
  terminal: "Settings → Terminal settings",
  theme: "Settings → Theme",
  formatter: "Settings → Formatter",
  lsp: "Settings → Language servers",
  plugins: "Settings → Plugins",
  files: "File browser → ⋮ → Settings",
  search: "Search bar (quick tools) → settings",
  icon: "Settings → App icon",
  /** Read by Acode but on no settings screen; Settings → Edit settings.json changes them by hand. */
  json: "settings.json only (Settings → Edit settings.json)",
} as const;

export type SettingInfo = {
  key: string;
  label: string;
  page: string;
  info?: string;
  /** Allowed values, when the setting is a choice. */
  options?: readonly (string | number)[];
  /** Takes effect only after Acode restarts or reloads. */
  reload?: boolean;
};

type Row = [
  key: string,
  page: keyof typeof PAGES,
  label: string,
  info?: string,
  options?: readonly (string | number)[],
];

/**
 * Acode's own settings, from the settings pages of Acode's main branch. Plugins and newer versions
 * may add keys; `acode_settings` still lists those, without a description.
 */
const ROWS: Row[] = [
  ["lang", "app", "Language", "App language and translated labels."],
  [
    "animation",
    "app",
    "Animation",
    "Transition animations across the app.",
    ["no", "yes", "system"],
  ],
  ["fullscreen", "app", "Fullscreen", "Hide the system status bar while using Acode."],
  ["uiZoom", "app", "UI zoom", "Scale text across the Acode interface, in percent."],
  [
    "keyboardMode",
    "app",
    "Keyboard mode",
    "How the software keyboard behaves while editing.",
    ["NORMAL", "NO_SUGGESTIONS", "NO_SUGGESTIONS_AGGRESSIVE"],
  ],
  ["vibrateOnTap", "app", "Vibrate on tap", "Haptic feedback for taps and controls."],
  ["showSideButtons", "app", "Show side buttons", "Extra action buttons beside the editor."],
  ["showSponsorSidebarApp", "app", "Sponsor sidebar app", "Show the sponsor entry in the sidebar."],
  [
    "openFileListPos",
    "app",
    "Active files",
    "Where the open files (tabs) list appears.",
    ["header", "sidebar", "bottom"],
  ],
  ["touchMoveThreshold", "app", "Touch move threshold", "Minimum movement before a drag."],
  ["floatingButton", "app", "Quick tools toggler", "Show the floating quick tools button."],
  [
    "quickTools",
    "app",
    "Quick tools height",
    "Rows of quick tools above the keyboard: 0 off, 1 compact, 2 full.",
    [0, 1, 2],
  ],
  [
    "quickToolsTriggerMode",
    "app",
    "Quick tools trigger mode",
    "Whether quick tools act on touch or on click.",
    ["touch", "click"],
  ],
  ["appFont", "app", "App font", "Font used across the app interface; empty for the default."],
  ["iconTheme", "app", "Icon pack", "Icons for files and folders."],
  ["rememberFiles", "app", "Remember files", "Reopen the files that were open last time."],
  ["rememberFolders", "app", "Remember folders", "Reopen folders from the previous session."],
  ["retryRemoteFsAfterFail", "app", "Retry FTP/SFTP after fail", "Retry failed remote transfers."],
  ["excludeFolders", "app", "Exclude files", "Glob patterns skipped while searching or scanning."],
  [
    "useFileOperationExclusions",
    "app",
    "Use exclusions for file operations",
    "Skip excluded files and folders during copy and paste.",
  ],
  ["defaultFileEncoding", "app", "Default file encoding", "Encoding for opening and new files."],
  ["confirmOnExit", "app", "Confirm on exit", "Ask before closing the app."],
  ["checkFiles", "app", "Check file changes", "Refresh editors when files change outside Acode."],
  ["checkForAppUpdates", "app", "Check for app updates", "Look for new Acode releases."],
  ["console", "app", "Console", "Debug console used by preview.", ["legacy", "eruda"]],
  ["developerMode", "app", "Developer mode", "Extra tools for plugin developers."],
  ["editorFont", "editor", "Editor font", "Typeface used in the editor."],
  ["fontSize", "editor", "Font size", "Editor text size as CSS, e.g. 14px."],
  ["lineHeight", "editor", "Line height", "Vertical spacing between lines, e.g. 1.5."],
  ["textWrap", "editor", "Text wrap", "Wrap long lines inside the editor."],
  [
    "wrappingIndent",
    "editor",
    "Wrapped line indent",
    "Indent of wrapped line continuations.",
    ["none", "same", "indent", "deepIndent"],
  ],
  [
    "autosave",
    "editor",
    "Autosave",
    "Delay in ms before saving automatically; 0 is off, else at least 1000.",
  ],
  ["softTab", "editor", "Soft tab", "Insert spaces instead of tab characters."],
  ["tabSize", "editor", "Tab size", "Spaces per indentation step."],
  ["formatOnSave", "editor", "Format on save", "Run the formatter whenever a file is saved."],
  ["liveAutoCompletion", "editor", "Live autocompletion", "Show suggestions while typing."],
  ["localWordCompletion", "editor", "Local word completion", "Suggest words from the file."],
  ["languageCompletion", "editor", "Language package completion", "Keywords and snippets."],
  [
    "recommendExtensions",
    "editor",
    "Recommend extensions",
    "Suggest plugins for unknown file types.",
  ],
  ["useEmmet", "editor", "Use Emmet", "Emmet abbreviations in HTML and CSS."],
  ["autoCloseTags", "editor", "Auto close tags", "Insert closing tags in HTML-like files."],
  ["autoRenameTags", "editor", "Auto rename tags", "Rename the matching HTML tag while editing."],
  ["colorPreview", "editor", "Color preview", "Preview color values inline."],
  ["linenumbers", "editor", "Show line numbers", "Line numbers in the gutter."],
  [
    "relativeLineNumbers",
    "editor",
    "Relative line numbers",
    "Show distance from the current line.",
  ],
  ["lintGutter", "editor", "Lint gutter", "Diagnostics markers in the gutter."],
  ["showSpaces", "editor", "Show spaces", "Visible whitespace markers."],
  ["indentGuides", "editor", "Indent guides", "Indentation guide lines."],
  ["rainbowBrackets", "editor", "Rainbow brackets", "Color brackets by nesting depth."],
  ["fadeFoldWidgets", "editor", "Fade fold widgets", "Dim fold markers until needed."],
  ["showShareButton", "editor", "Show share button", "Share button in the selection menu."],
  ["shiftClickSelection", "editor", "Shift click selection", "Extend selection with Shift + tap."],
  ["rtlText", "editor", "Line based RTL switching", "Right-to-left behavior per line."],
  ["scrollSpeed", "scroll", "Scroll speed", undefined, ["SLOW", "NORMAL", "FAST", "FAST_X2"]],
  ["reverseScrolling", "scroll", "Reverse scrolling"],
  ["diagonalScrolling", "scroll", "Diagonal scrolling"],
  ["scrollbarSize", "scroll", "Scrollbar size", "Width in px."],
  ["scrollbarHeight", "scroll", "Scrollbar height", "Height in px.", [20, 30, 40, 50, 60]],
  [
    "scrollPastEnd",
    "scroll",
    "Scroll past end",
    "Empty space below the last line.",
    ["none", "small", "medium", "full"],
  ],
  ["leftMargin", "scroll", "Horizontal scroll margin", "Space after the longest line, in px."],
  ["previewPort", "preview", "Preview port", "Port of the live preview server."],
  ["serverPort", "preview", "Server port", "Port of the internal app server."],
  ["previewMode", "preview", "Preview mode", "Where Run opens the preview.", ["inapp", "browser"]],
  ["host", "preview", "Host", "Hostname used for the preview URL."],
  ["disableCache", "preview", "Disable in-app browser cache", "Always reload preview content."],
  [
    "useCurrentFileForPreview",
    "preview",
    "Use current file for preview",
    "Preview the open file instead of index.html.",
  ],
  ["showConsoleToggler", "preview", "Show console toggler", "Console button in preview."],
  ["appTheme", "theme", "App theme", "Theme of the Acode interface; 'system' follows the device."],
  [
    "editorTheme",
    "theme",
    "Editor theme",
    "Syntax theme of the editor; ignored while the app theme is 'system'.",
  ],
  [
    "terminalSettings",
    "terminal",
    "Terminal settings",
    "Object: fontSize, fontFamily, fontWeight, letterSpacing, fontLigatures, showScrollbar, cursorStyle, cursorInactiveStyle, cursorBlink, scrollback, tabStopWidth, convertEol, imageSupport, confirmTabClose, theme.",
  ],
  [
    "formatter",
    "formatter",
    "Formatter",
    "Object mapping a language mode to the formatter id used for it.",
  ],
  [
    "lsp",
    "lsp",
    "Language servers",
    "Language server configuration; edit it in Settings → Language servers.",
  ],
  [
    "pluginsDisabled",
    "plugins",
    "Disabled plugins",
    "Object of plugin id → true for disabled plugins. Applies after a restart.",
  ],
  ["fileBrowser", "files", "File browser", "Object: showHiddenFiles, sortByName, listFiles."],
  ["search", "search", "Search options", "Object: caseSensitive, regExp, wholeWord."],
  ["appIcon", "icon", "App icon", "Launcher icon shown on the device."],
  [
    "maxFileSize",
    "json",
    "Max file size",
    "Largest file Acode opens, in MB; bigger files are refused.",
  ],
  ["cursorWidth", "json", "Cursor width", "Editor cursor width in px."],
  ["autoIndent", "json", "Auto indent", "Indent new lines to match the line above."],
  ["codeFolding", "json", "Code folding", "Fold markers in the gutter."],
  ["autoCloseBrackets", "json", "Auto close brackets", "Insert the closing bracket or quote."],
  ["bracketMatching", "json", "Bracket matching", "Highlight the bracket matching the cursor."],
  ["highlightActiveLine", "json", "Highlight active line", "Highlight the line with the cursor."],
  [
    "highlightSelectionMatches",
    "json",
    "Highlight selection matches",
    "Highlight other occurrences of the selected text.",
  ],
  [
    "showAnnotations",
    "json",
    "Show annotations",
    "Leave room for diagnostics beside line numbers.",
  ],
  ["maxRetryCount", "json", "Max retry count", "Retries when listing a remote folder fails."],
  ["showRetryToast", "json", "Show retry toast", "Show a toast on each of those retries."],
];

/** Settings kept from the agent: purchase, migration and storage internals, and dead keys. */
export const HIDDEN_SETTINGS: ReadonlySet<string> = new Set([
  "customTheme",
  "quicktoolsItems",
  "lineHeightMigrated",
  "prettier",
  // Left over from the Ace editor: nothing in this Acode reads them.
  "autoCorrect",
  "inlineAutoCompletion",
  "useTextareaForIME",
  "elasticTabstops",
  "printMargin",
  "showPrintMargin",
  "desktopMode",
]);

/** Settings that only apply after Acode reloads. */
const RELOAD_SETTINGS = new Set(["pluginsDisabled"]);

export const SETTINGS_CATALOG: ReadonlyMap<string, SettingInfo> = new Map(
  ROWS.map(([key, page, label, info, options]) => [
    key,
    {
      key,
      label,
      page: PAGES[page],
      ...(info ? { info } : {}),
      ...(options ? { options } : {}),
      ...(RELOAD_SETTINGS.has(key) ? { reload: true } : {}),
    },
  ]),
);
