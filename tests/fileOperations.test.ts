import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MutationGate } from "../src/permissions/mutationGate.ts";
import { createWorkspaceTools } from "../src/tools/createTools.ts";
import { AcodeWorkspace } from "../src/workspace/acodeWorkspace.ts";

const ROOT = "file:///project";

beforeEach(() => {
  vi.stubGlobal("editorManager", { getFile: () => undefined, files: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("file operation tools are only added when requested", () => {
  const { workspace } = memoryFs({});
  const names = (fileOperations?: boolean) =>
    createWorkspaceTools(workspace, { maxWalkFiles: () => 10, fileOperations }).map(
      (tool) => tool.name,
    );
  expect(names()).not.toContain("move_path");
  expect(names(true)).toEqual(
    expect.arrayContaining([
      "move_path",
      "rename_path",
      "copy_path",
      "delete_path",
      "create_directory",
    ]),
  );
});

test("move_path moves a file to a new folder and name, creating parents", async () => {
  const fs = memoryFs({ "src/a.ts": "a" });
  const output = await run(fs.workspace, "move_path", {
    source: "src/a.ts",
    destination: "lib/util/b.ts",
  });
  expect(fs.files).toEqual({ "lib/util/b.ts": "a" });
  expect(fs.folders.has("lib/util")).toBe(true);
  expect(text(output)).toBe("Moved src/a.ts to lib/util/b.ts.");
});

test("move_path steps aside when the target folder already has a file with the source name", async () => {
  const fs = memoryFs({ "src/a.ts": "moved", "lib/a.ts": "stays" });
  await run(fs.workspace, "move_path", { source: "src/a.ts", destination: "lib/b.ts" });
  expect(fs.files).toEqual({ "lib/a.ts": "stays", "lib/b.ts": "moved" });
});

test("move_path moves folders with their contents", async () => {
  const fs = memoryFs({ "src/ui/a.ts": "a", "src/ui/deep/b.ts": "b" });
  const output = await run(fs.workspace, "move_path", {
    source: "src/ui",
    destination: "app/view",
  });
  expect(fs.files).toEqual({ "app/view/a.ts": "a", "app/view/deep/b.ts": "b" });
  expect(text(output)).toBe("Moved folder src/ui to app/view.");
});

test("move_path refuses to overwrite, to move a folder into itself, or to move the root", async () => {
  const fs = memoryFs({ "a.ts": "a", "b.ts": "b", "src/x.ts": "x" });
  await expect(
    run(fs.workspace, "move_path", { source: "a.ts", destination: "b.ts" }),
  ).rejects.toThrow("Cannot move a.ts: b.ts already exists.");
  await expect(
    run(fs.workspace, "move_path", { source: "src", destination: "src/inner" }),
  ).rejects.toThrow("into itself");
  await expect(
    run(fs.workspace, "move_path", { source: ".", destination: "elsewhere" }),
  ).rejects.toThrow("workspace root");
  await expect(
    run(fs.workspace, "move_path", { source: "missing.ts", destination: "c.ts" }),
  ).rejects.toThrow("Check the path with list_dir or glob.");
  expect(fs.files).toEqual({ "a.ts": "a", "b.ts": "b", "src/x.ts": "x" });
});

test("move_path re-points open editor tabs and reports unsaved buffers", async () => {
  const fs = memoryFs({ "src/a.ts": "a", "src/b.ts": "b" });
  const tabA = { uri: `${ROOT}/src/a.ts`, filename: "a.ts", isUnsaved: true };
  const tabB = { uri: `${ROOT}/src/b.ts`, filename: "b.ts", isUnsaved: false };
  vi.stubGlobal("editorManager", { getFile: () => undefined, files: [tabA, tabB] });

  const output = await run(fs.workspace, "move_path", { source: "src", destination: "lib" });

  expect(tabA).toMatchObject({ uri: `${ROOT}/lib/a.ts`, filename: "a.ts" });
  expect(tabB).toMatchObject({ uri: `${ROOT}/lib/b.ts`, filename: "b.ts" });
  expect(text(output)).toContain("2 open editor tabs now point to the new path.");
  expect(text(output)).toContain("1 of them had unsaved changes");
});

test("rename_path renames in place and updates the tab name", async () => {
  const fs = memoryFs({ "src/old.ts": "x" });
  const tab = { uri: `${ROOT}/src/old.ts`, filename: "old.ts", isUnsaved: false };
  vi.stubGlobal("editorManager", { getFile: () => undefined, files: [tab] });

  await run(fs.workspace, "rename_path", { path: "src/old.ts", new_name: "new.ts" });

  expect(fs.files).toEqual({ "src/new.ts": "x" });
  expect(tab).toMatchObject({ uri: `${ROOT}/src/new.ts`, filename: "new.ts" });
});

test("rename_path handles case-only renames and rejects paths as names", async () => {
  const fs = memoryFs({ "readme.md": "x" });
  await run(fs.workspace, "rename_path", { path: "readme.md", new_name: "README.md" });
  expect(fs.files).toEqual({ "README.md": "x" });
  await expect(
    run(fs.workspace, "rename_path", { path: "README.md", new_name: "docs/README.md" }),
  ).rejects.toThrow("without slashes");
});

test("copy_path copies folders recursively and takes open buffers over disk", async () => {
  const fs = memoryFs({ "src/a.ts": "disk", "src/deep/b.bin": "bytes" });
  vi.stubGlobal("editorManager", {
    getFile: (uri: string) =>
      uri === `${ROOT}/src/a.ts`
        ? { loaded: true, session: { getValue: () => "buffer" } }
        : undefined,
    files: [],
  });

  const output = await run(fs.workspace, "copy_path", { source: "src", destination: "backup/src" });

  expect(fs.files).toEqual({
    "src/a.ts": "disk",
    "src/deep/b.bin": "bytes",
    "backup/src/a.ts": "buffer",
    "backup/src/deep/b.bin": "bytes",
  });
  expect(text(output)).toBe("Copied folder src to backup/src (2 files).");
});

test("delete_path deletes files, and folders only with recursive", async () => {
  const fs = memoryFs({ "a.ts": "a", "src/b.ts": "b" });
  fs.folders.add("empty");

  await run(fs.workspace, "delete_path", { path: "a.ts" });
  await run(fs.workspace, "delete_path", { path: "empty" });
  await expect(run(fs.workspace, "delete_path", { path: "src" })).rejects.toThrow(
    "src is a folder with 1 entry. Pass recursive: true",
  );
  const output = await run(fs.workspace, "delete_path", { path: "src", recursive: true });

  expect(fs.files).toEqual({});
  expect([...fs.folders]).toEqual([""]);
  expect(text(output)).toBe("Deleted folder src (1 entry).");
  await expect(run(fs.workspace, "delete_path", { path: "" })).rejects.toThrow("workspace root");
});

test("delete_path detaches open tabs so their buffers survive", async () => {
  const fs = memoryFs({ "a.ts": "a" });
  const tab = { uri: `${ROOT}/a.ts` as string | null, filename: "a.ts", isUnsaved: false };
  const onupdate = vi.fn();
  vi.stubGlobal("editorManager", {
    getFile: () => undefined,
    files: [tab],
    onupdate,
    emit: vi.fn(),
  });

  const output = await run(fs.workspace, "delete_path", { path: "a.ts" });

  expect(tab.uri).toBeNull();
  expect(onupdate).toHaveBeenCalledWith("delete-file");
  expect(text(output)).toContain("1 open editor tab kept as unsaved buffer.");
});

test("delete_path falls back to deleting children when a provider only removes empty folders", async () => {
  const fs = memoryFs({ "src/a.ts": "a", "src/deep/b.ts": "b" }, { recursiveDelete: false });
  await run(fs.workspace, "delete_path", { path: "src", recursive: true });
  expect(fs.files).toEqual({});
  expect([...fs.folders]).toEqual([""]);
});

test("create_directory creates parents and is idempotent", async () => {
  const fs = memoryFs({ "file.txt": "x" });
  expect(text(await run(fs.workspace, "create_directory", { path: "a/b/c" }))).toBe(
    "Created folder a/b/c.",
  );
  expect(fs.folders.has("a/b/c")).toBe(true);
  expect(text(await run(fs.workspace, "create_directory", { path: "a/b" }))).toBe(
    "Folder a/b already exists.",
  );
  await expect(run(fs.workspace, "create_directory", { path: "file.txt" })).rejects.toThrow(
    "already exists as a file",
  );
});

test("file operations tell Acode's file tree what changed", async () => {
  const fs = memoryFs({ "src/a.ts": "a" });
  const openFolder = { add: vi.fn(), removeItem: vi.fn() };
  fs.acode.require = (name: string) => (name === "openfolder" ? openFolder : undefined);

  await run(fs.workspace, "move_path", { source: "src/a.ts", destination: "lib/a.ts" });

  expect(openFolder.removeItem).toHaveBeenCalledWith(`${ROOT}/src/a.ts`);
  expect(openFolder.add).toHaveBeenCalledWith(`${ROOT}/lib`, "folder");
});

test("edits pass in allow-edits mode but deletes still ask, with their own session grant", async () => {
  const fs = memoryFs({ "src/a.ts": "a", "src/b.ts": "b" });
  const gate = new MutationGate();
  const request = (toolName: string, args: Record<string, unknown>) =>
    gate.request(toolName, args, fs.workspace, "allow-edits");

  expect(await request("move_path", { source: "src/a.ts", destination: "a.ts" })).toEqual({});
  expect(await request("create_directory", { path: "lib" })).toEqual({});

  const first = request("delete_path", { path: "src", recursive: true });
  await vi.waitFor(() => expect(gate.pending).toBeDefined());
  expect(gate.pending).toMatchObject({ toolName: "delete_path", title: "Delete src", path: "src" });
  expect(gate.pending!.preview).toContain("Delete folder src and everything inside it (2 entries)");
  expect(gate.pending!.preview).toContain("  a.ts\n  b.ts");
  gate.resolve("deny");
  expect(await first).toEqual({ block: true, reason: "User denied this delete." });

  const second = request("delete_path", { path: "src/a.ts" });
  await vi.waitFor(() => expect(gate.pending).toBeDefined());
  expect(gate.pending!.preview).toBe("Delete file src/a.ts (1B). This cannot be undone.");
  gate.resolve("allow-session");
  expect(await second).toEqual({});
  expect(await gate.request("delete_path", { path: "src/b.ts" }, fs.workspace, "ask")).toEqual({});

  // The delete grant does not cover edits in ask mode.
  const edit = gate.request("rename_path", { path: "a.ts", new_name: "b.ts" }, fs.workspace, "ask");
  await vi.waitFor(() => expect(gate.pending).toMatchObject({ title: "Rename a.ts" }));
  expect(gate.pending!.preview).toBe("a.ts\n→ b.ts");
  gate.dispose();
  expect(await edit).toEqual({ block: true, reason: "User denied this workspace edit." });
});

async function run(workspace: AcodeWorkspace, name: string, args: Record<string, unknown>) {
  const tool = createWorkspaceTools(workspace, {
    maxWalkFiles: () => 100,
    fileOperations: true,
  }).find((candidate) => candidate.name === name)!;
  return tool.execute("call", args);
}

function text(output: { content: Array<{ type: string; text?: string }> }): string {
  return output.content[0]?.text ?? "";
}

/**
 * An in-memory tree behind `acode.fsOperation`, with Acode's semantics: `moveTo` takes the
 * destination folder and keeps the name, `renameTo` takes a bare name, both return the new URL.
 */
function memoryFs(initial: Record<string, string>, options: { recursiveDelete?: boolean } = {}) {
  const files: Record<string, string> = { ...initial };
  const folders = new Set([""]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1)
      folders.add(parts.slice(0, depth).join("/"));
  }
  const relative = (uri: string) => uri.slice(ROOT.length).replace(/^\/+/, "");
  const url = (path: string) => (path ? `${ROOT}/${path}` : ROOT);
  const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
  const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
  const notFound = () => Promise.reject({ code: 1, message: "Path not found" });
  const taken = (path: string) => path in files || folders.has(path);
  const relocate = (from: string, to: string) => {
    if (taken(to)) throw { code: 12 };
    for (const path of Object.keys(files).filter((path) => under(path, from))) {
      files[to + path.slice(from.length)] = files[path]!;
      delete files[path];
    }
    for (const path of [...folders].filter((path) => under(path, from))) {
      folders.delete(path);
      folders.add(to + path.slice(from.length));
    }
    return url(to);
  };

  const acode = {
    joinUrl: (root: string, path: string) => `${root}/${path}`,
    require: (_name: string): unknown => undefined,
    fsOperation: (uri: string) => {
      const path = relative(uri);
      return {
        lsDir: async () => {
          if (!folders.has(path)) return notFound();
          const prefix = path ? `${path}/` : "";
          const children = new Set<string>();
          for (const candidate of [...Object.keys(files), ...folders]) {
            if (!candidate.startsWith(prefix) || candidate === path) continue;
            children.add(candidate.slice(prefix.length).split("/")[0]!);
          }
          return [...children].map((name) => {
            const isDirectory = folders.has(prefix + name);
            return { name, url: url(prefix + name), isDirectory, isFile: !isDirectory };
          });
        },
        readFile: async () => (path in files ? files[path] : notFound()),
        writeFile: async (content: string) => {
          files[path] = content;
        },
        exists: async () => taken(path),
        stat: async () => {
          if (path in files) return { isFile: true, isDirectory: false, size: files[path]!.length };
          if (folders.has(path)) return { isFile: false, isDirectory: true, size: 0 };
          return notFound();
        },
        createFile: async (name: string, content = "") => {
          if (taken(join(path, name))) throw { code: 12 };
          files[join(path, name)] = content;
          return url(join(path, name));
        },
        createDirectory: async (name: string) => {
          if (taken(join(path, name))) throw { code: 12 };
          folders.add(join(path, name));
          return url(join(path, name));
        },
        renameTo: async (name: string) => {
          if (!taken(path)) return notFound();
          return relocate(path, join(parentOf(path), name));
        },
        moveTo: async (destination: string) => {
          if (!taken(path)) return notFound();
          const folder = relative(destination);
          if (!folders.has(folder)) return notFound();
          return relocate(path, join(folder, path.split("/").pop()!));
        },
        delete: async () => {
          if (path in files) {
            delete files[path];
            return;
          }
          if (!folders.has(path)) return notFound();
          const inside = [...Object.keys(files), ...folders].filter(
            (candidate) => candidate !== path && under(candidate, path),
          );
          if (inside.length && options.recursiveDelete === false)
            throw new Error("Directory not empty");
          for (const candidate of inside) {
            delete files[candidate];
            folders.delete(candidate);
          }
          folders.delete(path);
        },
      };
    },
  };
  vi.stubGlobal("acode", acode);
  return { workspace: new AcodeWorkspace(ROOT, "project"), files, folders, acode };
}
