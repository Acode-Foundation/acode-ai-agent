import {
  BACKGROUND_CONTEXT,
  createEditTool,
  FileError,
  withAbortSignal,
  type EditToolDetails,
  type EditToolInput,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult, ReadImageProcessor } from "@earendil-works/pi-agent-core";
import { browserReadImageProcessor } from "../platform/readImageProcessor";
import { indexOmissions, NotDirectoryError } from "../workspace/acodeWorkspace";
import type { AcodeWorkspace, FileEntry, WalkResult } from "../workspace/acodeWorkspace";
import { isImagePath } from "../workspace/fileMentions";
import { workspaceRelativeFromIndex } from "../workspace/pathSandbox";
import { describeError, fileOperationError, isAbortError } from "./errors";
import { globMatcher } from "./glob";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  selectReadOutput,
  truncateHead,
} from "./truncate";
import { legacyEditArguments } from "./textEdits";
import { WorkspaceExecutionEnv } from "./workspaceEnv";

type ToolDetails = Partial<EditToolDetails> & {
  path?: string;
  operation: string;
  target?: "buffer" | "disk";
  count?: number;
  truncated?: boolean;
};

type ToolResult = AgentToolResult<ToolDetails>;

export function createWorkspaceTools(
  workspace: AcodeWorkspace,
  options: {
    maxWalkFiles: () => number;
    autoResizeImages?: () => boolean;
    imageProcessor?: ReadImageProcessor;
  },
): AgentTool<any>[] {
  const readFile: AgentTool<any> = {
    name: "read_file",
    label: "Read file",
    description:
      `Read a UTF-8 text file or image (jpg, png, gif, webp, bmp). Paths are relative to the active workspace. ` +
      `Images are returned as model-visible attachments. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. ` +
      `Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    executionMode: workspace.info.remote ? "sequential" : "parallel",
    execute: async (_id, params, signal) => {
      const input = params as { path: string; offset?: number; limit?: number };
      throwIfAborted(signal);
      const path = workspace.sandbox.normalize(input.path);
      if (isImagePath(path)) {
        const bytes = await workspace
          .readBinary(path)
          .catch((error: unknown) => Promise.reject(fileOperationError("read", path, error)));
        throwIfAborted(signal);
        const mimeType = detectSupportedImageMimeType(bytes);
        if (mimeType) {
          const processor = options.imageProcessor ?? browserReadImageProcessor;
          const processed = await processor(
            bytes,
            mimeType,
            {
              autoResizeImages: options.autoResizeImages?.() ?? true,
            },
            signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
          );
          if (!processed.ok) {
            return result(`Read image file [${mimeType}]\n${processed.message}`, {
              operation: "read",
              path,
            });
          }
          const hints = processed.hints.length ? `\n${processed.hints.join("\n")}` : "";
          return {
            content: [
              { type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
              { type: "image", data: processed.data, mimeType: processed.mimeType },
            ],
            details: { operation: "read", path },
          };
        }
      }
      const text = await workspace
        .readText(path)
        .catch((error: unknown) => Promise.reject(fileOperationError("read", path, error)));
      assertTextFile(path, text);
      const output = selectReadOutput(text, input.offset, input.limit);
      return result(output.text, { operation: "read", path, truncated: output.truncated });
    },
  };

  const listDir: AgentTool<any> = {
    name: "list_dir",
    label: "List directory",
    description:
      "List the direct children of a workspace directory, including hidden files. " +
      "Folders are listed first and end with '/'. Paths are workspace-relative, ready for other tools. " +
      `Shows up to ${LIST_DEFAULT_LIMIT} entries; use offset/limit to page through larger folders.`,
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Workspace-relative directory, empty for root" }),
      ),
      offset: Type.Optional(
        Type.Number({ description: "Number of entries to skip (to continue a truncated listing)" }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum entries to return (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT})`,
        }),
      ),
    }),
    executionMode: workspace.info.remote ? "sequential" : "parallel",
    execute: async (_id, params, signal) => {
      const input = params as { path?: string; offset?: number; limit?: number };
      throwIfAborted(signal);
      const path = workspace.sandbox.normalize(input.path ?? "");
      const label = path || "the workspace root";
      let entries: FileEntry[];
      try {
        entries = await workspace.list(path, signal);
      } catch (error) {
        if (isAbortError(error) || error instanceof NotDirectoryError) throw error;
        throw fileOperationError("list", label, error);
      }
      throwIfAborted(signal);

      const sorted = [...entries].sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
          a.name.localeCompare(b.name),
      );
      const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInteger(input.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT);
      if (sorted.length && offset >= sorted.length)
        throw new Error(`Offset ${offset} is beyond the ${sorted.length} entries in ${label}.`);
      const page = sorted.slice(offset, offset + limit);
      const lines = page.map((entry) => (entry.isDirectory ? `${entry.path}/` : entry.path));
      const next = offset + page.length;
      if (next < sorted.length) {
        lines.push(
          `[Showing entries ${offset + 1}-${next} of ${sorted.length}. Use offset=${next} to continue.]`,
        );
      }
      return result(lines.join("\n") || "Directory is empty.", {
        operation: "list",
        path,
        count: entries.length,
        truncated: next < sorted.length,
      });
    },
  };

  const grep: AgentTool<any> = {
    name: "grep",
    label: "Search workspace",
    description:
      "Search file contents for a string or regular expression. Returns `path:line: text` matches. " +
      `Returns up to ${GREP_DEFAULT_LIMIT} matches by default. ` +
      "A result that says the search was incomplete has NOT covered every file: continue with the offset it gives " +
      "(keeping query/path/glob the same) or narrow the search with path/glob before concluding a match does not exist.",
    parameters: Type.Object({
      query: Type.String({ description: "Text or regular expression to find" }),
      path: Type.Optional(
        Type.String({ description: "Workspace-relative directory or file to search" }),
      ),
      glob: Type.Optional(
        Type.String({
          description: "Only search files matching this glob, e.g. *.ts or src/**/*.css",
        }),
      ),
      case_sensitive: Type.Optional(Type.Boolean({ default: false })),
      regex: Type.Optional(
        Type.Boolean({ default: false, description: "Interpret query as a regular expression" }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum matches to return (default ${GREP_DEFAULT_LIMIT}, max ${GREP_MAX_LIMIT})`,
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "Number of files to skip before searching. Only use the value a previous incomplete result tells you to.",
        }),
      ),
    }),
    executionMode: workspace.info.remote ? "sequential" : "parallel",
    execute: async (_id, params, signal, onUpdate) => {
      const input = params as {
        query: string;
        path?: string;
        glob?: string;
        case_sensitive?: boolean;
        regex?: boolean;
        limit?: number;
        offset?: number;
      };
      const query = String(input.query ?? "");
      if (!query) throw new Error("Search query cannot be empty.");
      const caseSensitive = Boolean(input.case_sensitive);
      const regex = Boolean(input.regex);
      const expression = regex ? compileSearchRegex(query, caseSensitive) : undefined;
      const path = workspace.sandbox.normalize(input.path ?? "");
      const fileFilter = input.glob?.trim() ? globMatcher(input.glob) : undefined;
      const limit = clampInteger(input.limit, GREP_DEFAULT_LIMIT, 1, GREP_MAX_LIMIT);
      const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const scope = describeScope(path, input.glob);
      const details = (count: number, truncated: boolean): ToolDetails => ({
        operation: "grep",
        path: path || undefined,
        count,
        truncated,
      });

      // Offsets are only handed out by the file walk below, so a resumed search stays on it.
      if (offset === 0) {
        const indexed = await grepViaFileIndex(workspace, {
          query,
          path,
          caseSensitive,
          regex,
          limit,
          fileFilter,
          signal,
        });
        const omitted = omissionNotice({ source: "index", skippedFolders: [] });
        if (indexed && indexed.hits.length) {
          const lines = [...indexed.hits];
          if (indexed.limited)
            lines.push(
              `[Match limit of ${limit} reached; more matches exist. Raise limit (max ${GREP_MAX_LIMIT}) or narrow the query/path/glob.]`,
            );
          if (omitted) lines.push(omitted);
          return result(capOutput(lines), details(indexed.hits.length, indexed.limited));
        }
        if (indexed) {
          const searched = await workspace.indexedFileCount(path);
          if (searched)
            return result(
              [
                `No matches found in ${searched} indexed file${searched === 1 ? "" : "s"} in ${scope}.`,
                omitted,
              ]
                .filter(Boolean)
                .join("\n"),
              details(0, false),
            );
        }
      }

      const maxFiles = workspace.info.remote
        ? Math.min(REMOTE_GREP_FILES, options.maxWalkFiles())
        : options.maxWalkFiles();
      const needle = caseSensitive ? query : query.toLowerCase();
      const hits: string[] = [];
      let completedFiles = 0;
      let cutFile: string | undefined;
      const walk = await workspace.walk({
        path,
        maxFiles,
        skip: offset,
        filter: fileFilter ? (entry) => fileFilter.test(entry.path) : undefined,
        signal,
        onEntry: async (entry) => {
          if (isBinaryPath(entry.path)) {
            completedFiles += 1;
            return;
          }
          let text: string;
          try {
            text = await workspace.readText(entry.path);
            assertTextFile(entry.path, text);
          } catch (error) {
            if (isAbortError(error)) throw error;
            // Unreadable/binary files are skipped during bounded search.
            completedFiles += 1;
            return;
          }
          // Ask for one extra match to learn whether this file still has more.
          const room = limit - hits.length;
          const found = expression
            ? matchingRegexLines(text, expression, room + 1)
            : matchingLiteralLines(text, needle, caseSensitive, room + 1);
          for (const match of found.slice(0, room))
            hits.push(`${entry.path}:${match.line}: ${truncate(match.text.trim(), 240)}`);
          if (found.length > room) {
            cutFile = entry.path;
            return true;
          }
          completedFiles += 1;
          onUpdate?.(result(`Searched ${entry.path}`, { operation: "grep", count: hits.length }));
          return hits.length >= limit;
        },
      });

      const first = offset + 1;
      const last = offset + walk.visited;
      const range = walk.visited ? `files ${first}-${last}` : "no files";
      const next = offset + completedFiles;
      const matchLimited =
        cutFile !== undefined || (walk.stop === "callback" && hits.length >= limit);
      const filesRemain = walk.stop === "file-limit" || walk.stop === "scan-limit";
      const omitted = omissionNotice(walk);
      if (!hits.length) {
        let message: string;
        if (filesRemain) {
          message =
            `No matches found in ${range} of ${scope}, but the search is INCOMPLETE: it stopped at the ` +
            `${maxFiles}-file limit and more files remain. Continue with offset=${next} ` +
            "(same query/path/glob), or narrow the search with path/glob.";
        } else {
          const searched = offset ? `${range} of ${scope}` : `${walk.visited} files in ${scope}`;
          const skippedAll =
            offset && !walk.visited ? ` (offset ${offset} is past the last file)` : "";
          message = `No matches found in ${searched}${skippedAll}.`;
        }
        return result([message, omitted].filter(Boolean).join("\n"), details(0, filesRemain));
      }

      const lines = [...hits];
      if (matchLimited) {
        const resume = cutFile ? `; it re-searches ${cutFile}, so its first matches repeat` : "";
        lines.push(
          `[Match limit of ${limit} reached in ${range} of ${scope}. More matches may exist. ` +
            `Continue with offset=${next} (same query/path/glob)${resume}, raise limit (max ${GREP_MAX_LIMIT}), or narrow the search.]`,
        );
      } else if (filesRemain) {
        lines.push(
          `[Search INCOMPLETE: searched ${range} of ${scope} and stopped at the ${maxFiles}-file limit; more files remain. ` +
            `Continue with offset=${next} (same query/path/glob), or narrow the search with path/glob.]`,
        );
      }
      if (omitted) lines.push(omitted);
      return result(capOutput(lines), details(hits.length, matchLimited || filesRemain));
    },
  };

  const glob: AgentTool<any> = {
    name: "glob",
    label: "Find files",
    description:
      "Find files by a glob pattern such as **/*.ts, src/**, or **/*.{md,json,js}. Returns workspace-relative paths. " +
      `Returns up to ${GLOB_DEFAULT_LIMIT} files by default; a truncated result says which offset continues it, ` +
      "and any folders that were not searched are listed in a trailing note.",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern, matched against workspace-relative paths",
      }),
      path: Type.Optional(
        Type.String({ description: "Workspace-relative directory to search in" }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum files to return (default ${GLOB_DEFAULT_LIMIT}, max ${GLOB_MAX_LIMIT})`,
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "Number of matching files to skip (to continue a truncated result)",
        }),
      ),
    }),
    executionMode: workspace.info.remote ? "sequential" : "parallel",
    execute: async (_id, params, signal) => {
      const input = params as { pattern: string; path?: string; limit?: number; offset?: number };
      const pattern = String(input.pattern ?? "");
      if (!pattern.trim()) throw new Error("Glob pattern cannot be empty.");
      const matcher = globMatcher(pattern);
      const path = workspace.sandbox.normalize(input.path ?? "");
      const limit = clampInteger(input.limit, GLOB_DEFAULT_LIMIT, 1, GLOB_MAX_LIMIT);
      const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const maxScanned = workspace.info.remote ? REMOTE_GLOB_SCAN_FILES : GLOB_SCAN_FILES;
      const scope = describeScope(path);
      const matches: FileEntry[] = [];
      const walk = await workspace.walk({
        path,
        maxFiles: limit,
        maxScanned,
        skip: offset,
        filter: (entry) => matcher.test(entry.path),
        signal,
        onEntry: (entry) => {
          matches.push(entry);
        },
      });
      const next = offset + matches.length;
      const details: ToolDetails = {
        operation: "glob",
        path: path || undefined,
        count: matches.length,
        truncated: walk.truncated,
      };
      const omitted = omissionNotice(walk);
      if (!matches.length) {
        const message =
          walk.stop === "scan-limit"
            ? `No files matched ${pattern} in the first ${walk.scanned} files of ${scope}, but the scan is INCOMPLETE: ` +
              `it stopped at the ${maxScanned}-file scan limit. Narrow the search with path.`
            : `No files matched ${pattern} in ${walk.scanned} files in ${scope}` +
              `${offset ? ` after skipping ${walk.skipped} matching files` : ""}.`;
        return result([message, omitted].filter(Boolean).join("\n"), details);
      }
      const lines = matches.map((entry) => entry.path).sort();
      if (walk.stop === "file-limit") {
        lines.push(
          `[Showing matches ${offset + 1}-${next}; more files match. Use offset=${next} to continue, or narrow the pattern/path.]`,
        );
      } else if (walk.stop === "scan-limit") {
        lines.push(
          `[Scan INCOMPLETE: stopped at the ${maxScanned}-file scan limit, so more files may match. ` +
            "Narrow the search with path or a more specific pattern.]",
        );
      }
      if (omitted) lines.push(omitted);
      return result(lines.join("\n"), details);
    },
  };

  const writeFile: AgentTool<any> = {
    name: "write_file",
    label: "Write file",
    description:
      "Create or replace a UTF-8 text file. Requires user approval unless session approval is enabled.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { path: string; content: string };
      throwIfAborted(signal);
      const path = workspace.sandbox.normalize(input.path);
      assertWritable(path, input.content);
      const target = await workspace.writeText(path, input.content);
      return result(
        `Updated ${path} in the ${target === "buffer" ? "open editor buffer (not auto-saved)" : "workspace"}.`,
        {
          operation: "write",
          path,
          target,
        },
      );
    },
  };

  // Pi's edit tool, run against the workspace: multi-edit, CRLF/BOM preservation, tolerant
  // matching for whitespace and typographic quotes, and a diff for the change card.
  const piEdit = createEditTool();
  const editEnv = new WorkspaceExecutionEnv(workspace, assertTextFile);
  const editFile: AgentTool<any> = {
    name: "edit_file",
    label: "Edit file",
    description: `${piEdit.description} Changes to files open in the editor stay in their unsaved buffer.`,
    parameters: piEdit.parameters,
    prepareArguments: (args: unknown) =>
      piEdit.prepareArguments ? piEdit.prepareArguments(legacyEditArguments(args)) : args,
    executionMode: "sequential",
    execute: async (id, params, signal) => {
      throwIfAborted(signal);
      const input = params as EditToolInput;
      const path = workspace.sandbox.normalize(input.path);
      const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
      let output: AgentToolResult<EditToolDetails | undefined>;
      try {
        output = await piEdit.execute(
          id,
          { ...input, path },
          () => undefined,
          { env: editEnv },
          undefined as never,
          context,
        );
      } catch (error) {
        // Pi reports environment failures as "Error code: not_found"; keep the readable cause.
        const cause = (error as { cause?: unknown } | null)?.cause;
        if (cause instanceof FileError && cause.code !== "aborted")
          throw new Error(`Could not edit ${path}: ${describeError(cause)}`);
        throw error;
      }
      const target = editEnv.takeWriteTarget(path);
      const summary =
        output.content.find((part) => part.type === "text")?.text ?? `Edited ${path}.`;
      return result(
        target === "buffer"
          ? `${summary} The file is open in the editor, so the change is in its unsaved buffer.`
          : summary,
        {
          ...output.details,
          operation: "edit",
          path,
          target,
          count: Array.isArray(input.edits) ? input.edits.length : undefined,
        },
      );
    },
  };

  return [readFile, listDir, grep, glob, writeFile, editFile].map(withReadableErrors);
}

const LIST_DEFAULT_LIMIT = 500;
const LIST_MAX_LIMIT = 2000;
const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 1000;
const REMOTE_GREP_FILES = 80;
const GLOB_DEFAULT_LIMIT = 200;
const GLOB_MAX_LIMIT = 1000;
const GLOB_SCAN_FILES = 20_000;
const REMOTE_GLOB_SCAN_FILES = 2_000;

/**
 * Pi turns a thrown value into tool output with `error.message`, so a rejected Cordova
 * `FileError` or plain object would reach the model as "[object Object]".
 */
function withReadableErrors(tool: AgentTool<any>): AgentTool<any> {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (...args: Parameters<typeof execute>) => {
      try {
        return await execute(...args);
      } catch (error) {
        if (error instanceof Error && error.message) throw error;
        throw new Error(describeError(error), { cause: error });
      }
    },
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** A trailing note naming what the walk did not search, so "no match" is never misread. */
function omissionNotice(walk: Pick<WalkResult, "source" | "skippedFolders">): string | undefined {
  if (walk.source === "index") {
    const omissions = indexOmissions();
    const folders = [
      ...new Set(
        omissions.excludeFolders
          .map((pattern) => pattern.replace(/^(\*\*\/)+/, "").replace(/(\/\*\*)+$/, ""))
          .filter((name) => name && !/[*?[\]{}]/.test(name)),
      ),
    ];
    const parts: string[] = [];
    if (omissions.hidden) parts.push("hidden (dot) files and folders");
    if (folders.length)
      parts.push(
        `excluded folders (${folders.slice(0, 6).join(", ")}${folders.length > 6 ? ", …" : ""})`,
      );
    if (!parts.length) return undefined;
    return (
      `[Not searched: ${parts.join(" and ")}, which Acode's file index leaves out. ` +
      "Use list_dir, or pass one as path, to look inside it.]"
    );
  }
  if (!walk.skippedFolders.length) return undefined;
  const shown = walk.skippedFolders.slice(0, 6);
  const more = walk.skippedFolders.length - shown.length;
  return (
    `[Skipped folders: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. ` +
    "Pass one as path to search inside it.]"
  );
}

function describeScope(path: string, glob?: string): string {
  const where = path ? path : "the workspace";
  return glob?.trim() ? `${where} (glob ${glob.trim()})` : where;
}

/** Keep huge match lists inside Pi's tool-output budget, keeping any trailing notice. */
function capOutput(lines: string[]): string {
  const text = lines.join("\n");
  const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
  if (!truncation.truncated) return text;
  return `${truncation.content}\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)} after ${truncation.outputLines} of ${lines.length} lines. Lower limit or narrow the search.]`;
}

export { globMatcher } from "./glob";

function result(content: string, details: ToolDetails): ToolResult {
  return { content: [{ type: "text", text: content }], details };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function assertTextFile(path: string, content: string): void {
  if (isBinaryPath(path) || content.includes("\0"))
    throw new Error(`${path} appears to be binary.`);
  if (content.length > maxTextCharacters())
    throw new Error(`${path} exceeds Acode's configured file-size limit.`);
}

function assertWritable(path: string, content: string): void {
  if (!path) throw new Error("A file path is required.");
  assertTextFile(path, content);
}

function maxTextCharacters(): number {
  try {
    const settings = acode.require("settings") as Acode.Settings;
    return Math.max(1, settings.value.maxFileSize) * 1024 * 1024;
  } catch {
    return 12 * 1024 * 1024;
  }
}

function isBinaryPath(path: string): boolean {
  try {
    const helpers = acode.require("helpers") as Acode.Helpers | undefined;
    return helpers?.isBinary?.(path) === true;
  } catch {
    return false;
  }
}

export function detectSupportedImageMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff]) && bytes[3] !== 0xf7) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (asciiAt(bytes, 0, "BM") && bytes.length >= 26) return "image/bmp";
  return undefined;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return (
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function compileSearchRegex(query: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(query, caseSensitive ? "gm" : "gim");
  } catch (error) {
    throw new Error(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function matchingRegexLines(
  text: string,
  expression: RegExp,
  limit: number,
): Array<{ line: number; text: string }> {
  if (limit <= 0) return [];
  expression.lastIndex = 0;
  const hits: Array<{ line: number; text: string }> = [];
  let line = 1;
  let lineStart = 0;
  let scanOffset = 0;
  let lastReportedLine = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    while (scanOffset < match.index) {
      const newline = text.indexOf("\n", scanOffset);
      if (newline < 0 || newline >= match.index) break;
      line += 1;
      lineStart = newline + 1;
      scanOffset = newline + 1;
    }
    if (line !== lastReportedLine) {
      const newline = text.indexOf("\n", lineStart);
      const lineText = text
        .slice(lineStart, newline < 0 ? text.length : newline)
        .replace(/\r$/, "");
      hits.push({ line, text: lineText });
      lastReportedLine = line;
      if (hits.length >= limit) break;
    }
    if (match[0].length === 0) expression.lastIndex += 1;
  }
  return hits;
}

function matchingLiteralLines(
  text: string,
  needle: string,
  caseSensitive: boolean,
  limit: number,
): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  if (limit <= 0) return hits;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
    hits.push({ line: index + 1, text: line });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Search with Acode's native index, which reads every indexed file without the JavaScript
 * walk's file cap. Returns `undefined` when the index is unavailable or the search failed.
 */
async function grepViaFileIndex(
  workspace: AcodeWorkspace,
  search: {
    query: string;
    path: string;
    caseSensitive: boolean;
    regex: boolean;
    limit: number;
    fileFilter?: { test: (path: string) => boolean };
    signal?: AbortSignal;
  },
): Promise<{ hits: string[]; limited: boolean } | undefined> {
  const { path, limit, signal } = search;
  try {
    const index = acode.require("fileIndex") as Acode.FileIndex | undefined;
    if (!index || typeof index.search !== "function" || !index.supports(workspace.info.rootUri))
      return undefined;
    throwIfAborted(signal);
    const hits: string[] = [];
    const seen = new Set<string>();
    let limited = false;
    let stop!: () => void;
    const stopped = new Promise<"stopped">((resolve) => {
      stop = () => resolve("stopped");
    });
    const handle = index.search(
      {
        roots: [workspace.info.rootUri],
        search: search.query,
        options: {
          caseSensitive: search.caseSensitive,
          regExp: search.regex,
          // Index paths start with the workspace title, so anchor the folder anywhere below it.
          include: path ? `**/${path},**/${path}/**` : undefined,
        },
        overlays: dirtyEditorOverlays(),
        useIndex: false,
      },
      (event) => {
        if (limited) return;
        const batches =
          event.type === "search-results"
            ? event.data
            : event.type === "search-result"
              ? [event.data]
              : [];
        for (const item of batches) {
          const filePath = filePathFromSearch(item.file, workspace);
          if (path && filePath !== path && !filePath.startsWith(`${path}/`)) continue;
          if (search.fileFilter && !search.fileFilter.test(filePath)) continue;
          for (const match of item.matches ?? []) {
            const line = Number(match.position?.start?.line ?? 0) + 1;
            const text = `${filePath}:${line}: ${truncate((match.line || match.renderText || match.match || "").trim(), 240)}`;
            if (seen.has(text)) continue;
            if (hits.length >= limit) {
              limited = true;
              stop();
              return;
            }
            seen.add(text);
            hits.push(text);
          }
        }
      },
    );
    // A cancelled native search never reports completion, so race it against our own stop.
    handle.result.catch(() => undefined);
    signal?.addEventListener("abort", stop, { once: true });
    let finished: Awaited<typeof handle.result> | "stopped";
    try {
      finished = await Promise.race([handle.result, stopped]);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    if (finished === "stopped") void handle.cancel().catch(() => undefined);
    throwIfAborted(signal);
    if (finished !== "stopped" && finished.type === "error") return undefined;
    return { hits, limited };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function filePathFromSearch(
  file: Acode.FileIndexEntry | Record<string, unknown>,
  workspace: AcodeWorkspace,
): string {
  const record = file as Partial<Acode.FileIndexEntry>;
  return workspaceRelativeFromIndex(
    { path: record.path, url: record.url, uri: record.uri, name: record.name },
    workspace.sandbox,
    workspace.info.name,
  );
}

function dirtyEditorOverlays(): Record<string, string> {
  const overlays: Record<string, string> = {};
  try {
    for (const file of editorManager.files ?? []) {
      if (!file?.loaded || !file.uri || !file.session) continue;
      overlays[file.uri] = file.session.getValue();
    }
  } catch {
    // Editor manager is optional in tests and non-Acode hosts.
  }
  return overlays;
}
