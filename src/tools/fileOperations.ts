import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AcodeWorkspace, PathChange } from "../workspace/acodeWorkspace";
import { fileOperationError } from "./errors";

type FileOperationDetails = {
  operation: "move" | "rename" | "copy" | "delete" | "mkdir";
  path: string;
  destination?: string;
  kind?: PathChange["kind"];
  count?: number;
};

/**
 * Move, rename, copy, delete and create folders through `acode.fsOperation`, for workspaces
 * without `bash` (SAF, local storage, FTP, SFTP), so the agent can finish a refactor.
 */
export function createFileOperationTools(workspace: AcodeWorkspace): AgentTool<any>[] {
  const movePath: AgentTool<any> = {
    name: "move_path",
    label: "Move path",
    description:
      "Move or rename a file or folder. `destination` is the full new workspace-relative path, " +
      "not the folder to move into (src/a.ts → lib/a.ts). Missing parent folders are created. " +
      "Fails if the destination exists. Editor tabs follow the move; update imports and references yourself.",
    parameters: Type.Object({
      source: Type.String({ description: "Workspace-relative file or folder to move" }),
      destination: Type.String({ description: "Full workspace-relative path after the move" }),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { source: string; destination: string };
      const source = workspace.sandbox.normalize(input.source);
      const destination = workspace.sandbox.normalize(input.destination);
      const change = await workspace
        .move(source, destination, signal)
        .catch((error: unknown) => Promise.reject(fileOperationError("move", source, error)));
      return result(`Moved ${describe(change, source)} to ${destination}.${tabsNote(change)}`, {
        operation: "move",
        path: source,
        destination,
        kind: change.kind,
      });
    },
  };

  const renamePath: AgentTool<any> = {
    name: "rename_path",
    label: "Rename path",
    description:
      "Rename a file or folder in place. `new_name` is a name, not a path; use move_path to change folders. " +
      "Fails if the name is taken. Editor tabs follow the rename.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file or folder to rename" }),
      new_name: Type.String({ description: "New file or folder name, e.g. index.ts" }),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { path: string; new_name: string };
      const path = workspace.sandbox.normalize(input.path);
      const name = String(input.new_name ?? "").trim();
      if (!name || name === "." || name === ".." || /[/\\]/.test(name))
        throw new Error("new_name must be a single file or folder name without slashes.");
      const slash = path.lastIndexOf("/");
      const destination = workspace.sandbox.normalize(
        slash >= 0 ? `${path.slice(0, slash)}/${name}` : name,
      );
      const change = await workspace
        .move(path, destination, signal)
        .catch((error: unknown) => Promise.reject(fileOperationError("rename", path, error)));
      return result(`Renamed ${describe(change, path)} to ${destination}.${tabsNote(change)}`, {
        operation: "rename",
        path,
        destination,
        kind: change.kind,
      });
    },
  };

  const copyPath: AgentTool<any> = {
    name: "copy_path",
    label: "Copy path",
    description:
      "Copy a file or folder (recursively) to a new path. `destination` is the full workspace-relative path of the copy. " +
      "Binary files are copied as-is; files open in the editor are copied from their buffer. Fails if the destination exists.",
    parameters: Type.Object({
      source: Type.String({ description: "Workspace-relative file or folder to copy" }),
      destination: Type.String({ description: "Full workspace-relative path of the copy" }),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { source: string; destination: string };
      const source = workspace.sandbox.normalize(input.source);
      const destination = workspace.sandbox.normalize(input.destination);
      const change = await workspace
        .copy(source, destination, signal)
        .catch((error: unknown) => Promise.reject(fileOperationError("copy", source, error)));
      const files =
        change.files === undefined ? "" : ` (${change.files} file${change.files === 1 ? "" : "s"})`;
      return result(`Copied ${describe(change, source)} to ${destination}${files}.`, {
        operation: "copy",
        path: source,
        destination,
        kind: change.kind,
        count: change.files,
      });
    },
  };

  const deletePath: AgentTool<any> = {
    name: "delete_path",
    label: "Delete path",
    description:
      "Permanently delete a file or folder; there is no trash or undo. A folder that is not empty needs recursive: true. " +
      "Asks the user for approval even in Allow edits mode.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file or folder to delete" }),
      recursive: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Delete a non-empty folder and everything inside it",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { path: string; recursive?: boolean };
      const path = workspace.sandbox.normalize(input.path);
      const change = await workspace
        .remove(path, { recursive: input.recursive === true, signal })
        .catch((error: unknown) => Promise.reject(fileOperationError("delete", path, error)));
      const tabs = change.openFiles
        ? ` ${plural(change.openFiles, "open editor tab")} kept as unsaved buffer${change.openFiles === 1 ? "" : "s"}.`
        : "";
      return result(`Deleted ${describe(change, path)}.${tabs}`, {
        operation: "delete",
        path,
        kind: change.kind,
        count: change.entries,
      });
    },
  };

  const createDirectory: AgentTool<any> = {
    name: "create_directory",
    label: "Create folder",
    description:
      "Create a folder and any missing parents. Only needed for empty folders; write_file creates parent folders itself.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative folder to create" }),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = params as { path: string };
      const path = workspace.sandbox.normalize(input.path);
      if (!path) throw new Error("A folder path is required.");
      const created = await workspace
        .createDirectory(path)
        .catch((error: unknown) => Promise.reject(fileOperationError("create", path, error)));
      return result(created ? `Created folder ${path}.` : `Folder ${path} already exists.`, {
        operation: "mkdir",
        path,
        kind: "folder",
      });
    },
  };

  return [movePath, renamePath, copyPath, deletePath, createDirectory];
}

function describe(change: PathChange & { entries?: number }, path: string): string {
  if (change.kind === "file") return path;
  return change.entries === undefined
    ? `folder ${path}`
    : `folder ${path} (${plural(change.entries, "entry", "entries")})`;
}

function tabsNote(change: PathChange): string {
  if (!change.openFiles) return "";
  const unsaved = change.unsavedFiles
    ? ` ${change.unsavedFiles} of them had unsaved changes, which stay in the editor buffer.`
    : "";
  return ` ${plural(change.openFiles, "open editor tab")} now point${change.openFiles === 1 ? "s" : ""} to the new path.${unsaved}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function result(
  text: string,
  details: FileOperationDetails,
): AgentToolResult<FileOperationDetails> {
  return { content: [{ type: "text", text }], details };
}
