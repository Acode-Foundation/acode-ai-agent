import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { ACODE_GUIDE, GUIDE_TOPICS } from "./acodeGuide";
import { HIDDEN_SETTINGS, SETTINGS_CATALOG, type SettingInfo } from "./acodeSettingsCatalog";
import { createAcodeUiTool } from "./acodeUi";
import { offersAllTools } from "./toolSearch";
import { webRequest } from "./web/request";

/** Tools that change Acode itself; each asks for approval like a workspace edit. */
export const ACODE_SETTINGS_TOOL = "acode_update_settings";
export const ACODE_RUN_COMMAND_TOOL = "acode_run_command";

const PLUGIN_API = "https://acode.app/api";
const COMMANDS_LIMIT = 80;
const PLUGINS_LIMIT = 20;
const VALUE_PREVIEW = 160;

/** `loaded`: tools this result loaded for the next turn, which keeps them loaded (see `toolsInUse`). */
type Details = { operation: string; count?: number; loaded?: string[] };

/**
 * Tools for Acode itself: how it works, its settings, commands, plugins, and screens. All of them
 * are deferred, so they cost nothing until the model loads them for an Acode question.
 */
export function createAcodeTools(): ToolRegistration[] {
  const guide = defineTool({
    name: "acode_guide",
    description:
      "How Acode (the Android editor you run in) and this AI Agent plugin work: menus, shortcuts, run/preview, " +
      "terminal, plugins, themes, language servers, formatting, files, and how the user works with you. " +
      "Use it before answering questions about Acode or about using this agent.",
    parameters: Type.Object({
      topic: Type.String({ description: `One of: ${GUIDE_TOPICS.join(", ")}` }),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, api, context) => {
      const topic = args.topic.trim().toLowerCase();
      const text = ACODE_GUIDE[topic];
      if (!text)
        throw new Error(`Unknown topic "${args.topic}". Topics: ${GUIDE_TOPICS.join(", ")}.`);
      return withNext(
        result(
          `${text}\n\nOther topics: ${GUIDE_TOPICS.filter((name) => name !== topic).join(", ")}.`,
          { operation: "guide" },
        ),
        ["acode_settings", "acode_commands", "acode_plugins"],
        api,
        context,
      );
    },
  });

  const settings = defineTool({
    name: "acode_settings",
    description:
      "Find Acode settings: each with its key, current value, label, where it is in Acode's UI, and allowed values. " +
      "Search by words (e.g. 'font size', 'tab', 'theme') or pass exact keys.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Words to match; omit to list every setting" }),
      ),
      keys: Type.Optional(Type.Array(Type.String(), { description: "Exact setting keys" })),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, api, context) => {
      const values = settingsValues();
      const visible = Object.keys(values).filter((key) => !HIDDEN_SETTINGS.has(key));
      let keys: string[];
      const missing: string[] = [];
      if (args.keys?.length) {
        keys = [];
        for (const key of args.keys) (key in values ? keys : missing).push(key);
      } else if (args.query?.trim()) {
        const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        keys = visible.filter((key) => {
          const haystack = searchText(key, SETTINGS_CATALOG.get(key));
          return terms.every((term) => haystack.includes(term));
        });
        // Every word is strict; fall back to any word so "editor font size" still finds fontSize.
        if (!keys.length)
          keys = visible.filter((key) => {
            const haystack = searchText(key, SETTINGS_CATALOG.get(key));
            return terms.some((term) => term.length > 2 && haystack.includes(term));
          });
      } else {
        keys = visible;
      }
      // Everything at once reads best as one short line per setting, by page; details on request.
      const lines =
        keys === visible
          ? overview(keys, values)
          : keys.map((key) => describeSetting(key, values[key], Boolean(args.keys?.length)));
      if (missing.length) lines.push(`Not Acode settings: ${missing.join(", ")}.`);
      return withNext(
        result(lines.join("\n") || "No matching settings.", {
          operation: "settings",
          count: keys.length,
        }),
        [ACODE_SETTINGS_TOOL],
        api,
        context,
      );
    },
  });

  const updateSettings = defineTool({
    name: ACODE_SETTINGS_TOOL,
    description:
      "Change Acode settings after the user approves. Look keys and allowed values up with acode_settings first. " +
      "Object settings (terminalSettings, fileBrowser, search) merge the fields you pass.",
    parameters: Type.Object({
      changes: Type.Array(
        Type.Object({
          key: Type.String({ description: "Setting key, e.g. fontSize" }),
          value: Type.String({
            description: 'New value as JSON, e.g. 4, true, "14px", {"cursorBlink":true}',
          }),
        }),
      ),
    }),
    // Models that guess the shape send `settings`, a JSON string, `{ key, value }`, or a plain map.
    prepareArguments: (args) => ({ changes: normalizeChanges(args) }),
    executionMode: "sequential",
    execute: async (args) => {
      if (!args.changes.length) throw new Error("Pass at least one change.");
      const api = settingsApi();
      const planned = args.changes.map((change) => planChange(change.key, change.value));
      const lines: string[] = [];
      const plain: Record<string, unknown> = {};
      for (const change of planned) {
        if (change.key === "appTheme") {
          const themes = acode.require("themes") as
            | { apply(id: string, init?: boolean): void | Promise<void> }
            | undefined;
          if (!themes) throw new Error("Acode's theme API is unavailable.");
          await themes.apply(change.next as string, true);
        } else if (change.key === "editorTheme") {
          const editor = editorManager.editor as unknown as { setTheme?(id: string): boolean };
          if (editor.setTheme && editor.setTheme(change.next as string) === false)
            throw new Error(`The editor rejected theme ${String(change.next)}.`);
          plain.editorTheme = change.next;
        } else {
          plain[change.key] = change.next;
        }
        const reload = SETTINGS_CATALOG.get(change.key)?.reload
          ? " (applies after Acode restarts)"
          : "";
        lines.push(`${change.key}: ${preview(change.current)} → ${preview(change.next)}${reload}`);
      }
      if (Object.keys(plain).length)
        await api.update(plain as Partial<Acode.ISettings>, false, true);
      return result(`Updated:\n${lines.join("\n")}`, {
        operation: "update_settings",
        count: planned.length,
      });
    },
  });

  const commands = defineTool({
    name: "acode_commands",
    description:
      "List Acode commands (built-in and plugin-added, the same as the command palette) with descriptions and " +
      "shortcuts. Search by words such as 'terminal', 'theme', 'split', 'format'.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words to match; omit to list all" })),
    }),
    executionMode: "parallel",
    replay: "safe",
    execute: async (args, api, context) => {
      const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const all = commandRegistry().list();
      const matches = all.filter((command) => {
        const haystack =
          `${command.name} ${splitWords(command.name)} ${command.description ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      const lines = matches
        .slice(0, COMMANDS_LIMIT)
        .map(
          (command) =>
            `${command.name}${command.description ? ` — ${command.description}` : ""}${command.key ? ` [${command.key}]` : ""}`,
        );
      if (matches.length > COMMANDS_LIMIT)
        lines.push(`[${matches.length - COMMANDS_LIMIT} more; narrow the query.]`);
      return withNext(
        result(lines.join("\n") || "No matching commands.", {
          operation: "commands",
          count: matches.length,
        }),
        [ACODE_RUN_COMMAND_TOOL],
        api,
        context,
      );
    },
  });

  const runCommand = defineTool({
    name: ACODE_RUN_COMMAND_TOOL,
    description:
      "Run an Acode command by name after the user approves, e.g. openTerminal, showSettingsMenu, openPluginsPage, " +
      "toggleSidebar, splitPaneRight, formatCode, saveAllChanges. Find names with acode_commands. Commands that open " +
      "a page or dialog take the user away from this chat.",
    parameters: Type.Object({
      name: Type.String({ description: "Command name from acode_commands" }),
      args: Type.Optional(
        Type.String({ description: "Optional JSON argument some commands take" }),
      ),
    }),
    executionMode: "sequential",
    execute: async (args) => {
      const registry = commandRegistry();
      const command = findCommand(registry.list(), args.name);
      if (!command)
        throw new Error(`No Acode command named ${args.name}. Search with acode_commands.`);
      const ran = registry.execute(
        command.name,
        undefined,
        args.args ? parseValue(args.args) : undefined,
      );
      return result(
        ran
          ? `Ran ${command.name}.`
          : `${command.name} did not run. It may need an editor file in focus or not apply right now.`,
        { operation: "run_command" },
      );
    },
  });

  const plugins = defineTool({
    name: "acode_plugins",
    description:
      "Acode plugins: list installed ones (id, version, enabled), search the plugin store, read a store plugin's " +
      "description, or install one by id (Acode asks the user to confirm).",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("installed"),
          Type.Literal("search"),
          Type.Literal("info"),
          Type.Literal("install"),
        ],
        { description: "installed | search | info | install" },
      ),
      query: Type.Optional(Type.String({ description: "Plugin name words, for search" })),
      id: Type.Optional(Type.String({ description: "Plugin id, for info and install" })),
    }),
    executionMode: "sequential",
    execute: async (args, _api, context) => {
      const signal = context.abortSignal;
      switch (args.action) {
        case "installed":
          return installedPlugins();
        case "search": {
          const query = args.query?.trim();
          if (!query) throw new Error("Pass query to search the plugin store.");
          const found = await storeJson<StorePlugin[]>(
            `/plugins?name=${encodeURIComponent(query)}&supported_editor=cm&limit=${PLUGINS_LIMIT}`,
            signal,
          );
          const lines = (Array.isArray(found) ? found : [])
            .slice(0, PLUGINS_LIMIT)
            .map(describeStorePlugin);
          return result(lines.join("\n") || `No store plugins match "${query}".`, {
            operation: "plugin_search",
            count: lines.length,
          });
        }
        case "info": {
          const id = requireId(args.id);
          const plugin = await storeJson<StorePlugin & { description?: string }>(
            `/plugin/${encodeURIComponent(id)}`,
            signal,
          );
          const description = (plugin.description ?? "").slice(0, 4_000);
          return result(`${describeStorePlugin(plugin)}\n\n${description || "No description."}`, {
            operation: "plugin_info",
          });
        }
        case "install": {
          const id = requireId(args.id);
          await acode.installPlugin(id, "AI Agent");
          return result(`Installed ${id}.`, { operation: "plugin_install" });
        }
        default:
          throw new Error("action must be installed, search, info or install.");
      }
    },
  });

  return [guide, settings, updateSettings, commands, runCommand, plugins, createAcodeUiTool()];
}

/** What an approval prompt shows for the Acode tools that change something. */
export function acodeActionPreview(toolName: string, args: Record<string, unknown>): string {
  if (toolName === ACODE_RUN_COMMAND_TOOL) {
    const name = String(args.name ?? "");
    try {
      const command = findCommand(commandRegistry().list(), name);
      return `Run Acode command ${command?.name ?? name}${command?.description ? `\n${command.description}` : ""}`;
    } catch {
      return `Run Acode command ${name}`;
    }
  }
  const changes = Array.isArray(args.changes)
    ? (args.changes as { key?: unknown; value?: unknown }[])
    : [];
  let values: Record<string, unknown> = {};
  try {
    values = settingsValues();
  } catch {
    // Preview without current values.
  }
  return changes
    .map((change) => {
      const key = String(change.key ?? "");
      const label = SETTINGS_CATALOG.get(key)?.label;
      return `${label ? `${label} (${key})` : key}: ${preview(values[key])} → ${String(change.value ?? "")}`;
    })
    .join("\n");
}

type StorePlugin = {
  id?: string;
  name?: string;
  version?: string;
  author?: string;
  downloads?: number;
  price?: number;
};

function settingsApi(): Acode.Settings {
  const api = acode.require("settings") as Acode.Settings | undefined;
  if (!api?.value) throw new Error("Acode's settings API is unavailable.");
  return api;
}

function settingsValues(): Record<string, unknown> {
  return settingsApi().value as unknown as Record<string, unknown>;
}

function commandRegistry(): Acode.CommandRegistry {
  const registry = (acode.require("commands") as Acode.Commands | undefined)?.registry;
  if (!registry) throw new Error("This Acode version has no command API; update Acode.");
  return registry;
}

function findCommand(
  list: Acode.RegisteredCommand[],
  name: string,
): Acode.RegisteredCommand | undefined {
  const wanted = name.trim();
  return (
    list.find((command) => command.name === wanted) ??
    list.find((command) => command.name.toLowerCase() === wanted.toLowerCase())
  );
}

function searchText(key: string, info: SettingInfo | undefined): string {
  return [key, splitWords(key), info?.label, info?.info, info?.page]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** `relativeLineNumbers` → `relative line numbers`, so word queries find camelCase keys. */
function splitWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_:]/g, " ");
}

function describeSetting(key: string, value: unknown, full: boolean): string {
  const info = SETTINGS_CATALOG.get(key);
  const shown = full ? JSON.stringify(value) : preview(value);
  if (!info) return `${key} = ${shown}`;
  const options = optionsFor(key, info);
  return [
    `${key} = ${shown}`,
    `${info.label} (${info.page})`,
    ...(options?.length ? [`one of: ${options.join(", ")}`] : []),
    ...(info.info ? [info.info] : []),
  ].join(" · ");
}

/** Allowed values; themes come from what is installed. */
function optionsFor(key: string, info: SettingInfo): readonly (string | number)[] | undefined {
  try {
    if (key === "appTheme") return appThemes()?.map((theme) => theme.id);
    if (key === "editorTheme") {
      const list = (acode.require("editorThemes") as Acode.EditorThemes | undefined)?.list() ?? [];
      return list.map((theme) => (typeof theme === "string" ? theme : theme.id));
    }
  } catch {
    // Fall back to the catalog.
  }
  return info.options;
}

type AppTheme = { id: string; version?: string };

/** Installed app themes. Acode lists objects; older versions listed names. */
function appThemes(): AppTheme[] | undefined {
  const list = (acode.require("themes") as { list(): (string | AppTheme)[] } | undefined)?.list();
  return list?.map((theme) => (typeof theme === "string" ? { id: theme } : theme));
}

/** A paid theme applies only with Acode Pro; buying it is the user's to do. */
function assertThemeUsable(id: string): void {
  const theme = appThemes()?.find((entry) => entry.id === id);
  const config = acode.require("config") as { HAS_PRO?: boolean } | undefined;
  if (theme?.version === "paid" && config?.HAS_PRO === false)
    throw new Error(`${id} is a paid theme. The user can unlock it in Settings → Theme.`);
}

type PlannedChange = { key: string; current: unknown; next: unknown };

/** Parse and check one change against the setting's current value and allowed values. */
function planChange(key: string, raw: string): PlannedChange {
  const values = settingsValues();
  if (!(key in values) || HIDDEN_SETTINGS.has(key))
    throw new Error(`${key} is not an Acode setting. Find keys with acode_settings.`);
  const current = values[key];
  let next = coerce(parseValue(raw), current);
  if (isPlainObject(current)) {
    if (!isPlainObject(next))
      throw new Error(`${key} is an object; pass a JSON object of fields to change.`);
    next = { ...current, ...next };
  } else if (current !== null && current !== undefined && typeof next !== typeof current) {
    throw new Error(
      `${key} takes a ${Array.isArray(current) ? "list" : typeof current}, not ${JSON.stringify(next)}.`,
    );
  }
  const info = SETTINGS_CATALOG.get(key);
  const options = info ? optionsFor(key, info) : undefined;
  if (options?.length && !options.includes(next as string | number))
    throw new Error(`${key} must be one of: ${options.join(", ")}.`);
  if (key === "appTheme") assertThemeUsable(next as string);
  return { key, current, next };
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Accept "true", "14" and the like for boolean and number settings. */
function coerce(value: unknown, current: unknown): unknown {
  if (typeof value !== "string") return value;
  if (typeof current === "boolean" && (value === "true" || value === "false"))
    return value === "true";
  if (typeof current === "number" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: unknown): string {
  const text = value === undefined ? "unset" : JSON.stringify(value);
  return text.length > VALUE_PREVIEW ? `${text.slice(0, VALUE_PREVIEW)}…` : text;
}

async function installedPlugins(): Promise<ToolExecutionResult<Details>> {
  const fs = acode.require("fs") as ((url: string) => Acode.FileSystem) | undefined;
  if (!fs) throw new Error("Acode's file system API is unavailable.");
  const disabled = (settingsValues().pluginsDisabled ?? {}) as Record<string, boolean>;
  const entries = await fs(PLUGIN_DIR).lsDir();
  const lines = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory)
      .map(async (entry) => {
        const id = entry.name;
        const state = disabled[id] ? "disabled" : "enabled";
        try {
          const manifest = (await fs(`${entry.url.replace(/\/$/, "")}/plugin.json`).readFile(
            "json",
          )) as {
            name?: string;
            version?: string;
          };
          return `${id} · ${manifest.name ?? id} v${manifest.version ?? "?"} · ${state}`;
        } catch {
          return `${id} · ${state} · plugin.json unreadable`;
        }
      }),
  );
  lines.sort();
  return result(lines.join("\n") || "No plugins installed.", {
    operation: "plugins_installed",
    count: lines.length,
  });
}

async function storeJson<T>(path: string, signal: AbortSignal | undefined): Promise<T> {
  const response = await webRequest(`${PLUGIN_API}${path}`, { signal, timeoutMs: 20_000 });
  if (!response.ok) throw new Error(`The plugin store answered ${response.status}.`);
  return (await response.json()) as T;
}

function describeStorePlugin(plugin: StorePlugin): string {
  return [
    plugin.id,
    `${plugin.name ?? "?"} v${plugin.version ?? "?"}`,
    plugin.author ? `by ${plugin.author}` : undefined,
    plugin.downloads !== undefined ? `${plugin.downloads} downloads` : undefined,
    plugin.price ? `paid (${plugin.price})` : "free",
  ]
    .filter(Boolean)
    .join(" · ");
}

function requireId(id: string | undefined): string {
  const value = id?.trim();
  if (!value) throw new Error("Pass the plugin id.");
  return value;
}

function result(text: string, details: Details): ToolExecutionResult<Details> {
  return { output: [{ type: "text", text }], details };
}

/**
 * Loads the tools a result leads to (settings → updating them, commands → running one) for the
 * next turn, so the model needs no `tool_search` for the obvious next step. User chats only:
 * a subagent's tool list is fixed, and adding to it would widen what it may do.
 */
async function withNext(
  output: ToolExecutionResult<Details>,
  next: readonly string[],
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult<Details>> {
  try {
    if (!(await api.commit((tx) => offersAllTools(tx, api.conversationId), context))) return output;
    const active = new Set((await api.agent(context)).tools.map((tool) => tool.name));
    const loaded = next.filter((name) => !active.has(name));
    if (!loaded.length) return output;
    return {
      output: [
        ...(output.output ?? []),
        { type: "text", text: `\n(Loaded for your next turn: ${loaded.join(", ")}.)` },
      ],
      details: { ...output.details!, loaded },
      control: { addTools: loaded },
    };
  } catch {
    // Outside a harness (tests, scripts) there is nothing to load into.
    return output;
  }
}

/** `{ changes: [...] }` from the shapes models send when guessing this tool's parameters. */
export function normalizeChanges(args: unknown): { key: string; value: string }[] {
  const input = (isPlainObject(args) ? args : {}) as Record<string, unknown>;
  let changes: unknown =
    input.changes ?? input.settings ?? input.values ?? input.updates ?? input.change;
  if (changes === undefined && typeof input.key === "string") changes = [input];
  if (typeof changes === "string") changes = parseValue(changes);
  if (isPlainObject(changes) && typeof changes.key === "string") changes = [changes];
  // A plain map: { fontSize: "14px", tabSize: 4 }.
  if (isPlainObject(changes))
    changes = Object.entries(changes).map(([key, value]) => ({ key, value }));
  if (!Array.isArray(changes)) return [];
  return changes.filter(isPlainObject).map((change) => ({
    key: String(change.key ?? change.name ?? ""),
    value: typeof change.value === "string" ? change.value : JSON.stringify(change.value ?? null),
  }));
}

/** Every setting as `key = value`, grouped by where it lives, with nothing cut off. */
function overview(keys: readonly string[], values: Record<string, unknown>): string[] {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const page = SETTINGS_CATALOG.get(key)?.page ?? "Other (settings.json)";
    const group = groups.get(page) ?? [];
    group.push(`${key} = ${preview(values[key])}`);
    groups.set(page, group);
  }
  return [
    ...[...groups].flatMap(([page, lines]) => [`${page}:`, ...lines.map((line) => `  ${line}`)]),
    "Ask with query or keys for a setting's label, description and allowed values.",
  ];
}
