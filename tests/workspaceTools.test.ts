import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorkspaceTools } from "../src/tools/createTools.ts";
import { describeError } from "../src/tools/errors.ts";
import { AcodeWorkspace } from "../src/workspace/acodeWorkspace.ts";

const ROOT = "file:///project";

beforeEach(() => {
  vi.stubGlobal("editorManager", { getFile: () => undefined, files: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("grep reports an incomplete search instead of a bare 'no matches' at the file cap", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 5; index += 1) files[`a${index}.txt`] = "nothing here";
  files["z.txt"] = "needle";
  const grep = tool(memoryWorkspace(files), "grep", 3);

  const first = await grep.execute("g1", { query: "needle" });
  expect(text(first)).toContain("No matches found in files 1-3 of the workspace");
  expect(text(first)).toContain("INCOMPLETE");
  expect(text(first)).toContain("offset=3");
  expect(first.details).toMatchObject({ count: 0, truncated: true });

  const second = await grep.execute("g2", { query: "needle", offset: 3 });
  expect(text(second)).toBe("z.txt:1: needle");
  expect(second.details).toMatchObject({ count: 1, truncated: false });
});

test("grep says a search is complete when every file was read", async () => {
  const grep = tool(memoryWorkspace({ "a.txt": "x", "src/b.txt": "y" }), "grep", 10);

  const output = await grep.execute("g", { query: "needle" });

  expect(text(output)).toBe("No matches found in 2 files in the workspace.");
  expect(output.details).toMatchObject({ truncated: false });
});

test("grep resumes at a file cut by the match limit", async () => {
  const grep = tool(memoryWorkspace({ "a.txt": "hit\nhit\nhit", "b.txt": "hit" }), "grep", 10);

  const output = await grep.execute("g", { query: "hit", limit: 2 });

  expect(text(output)).toContain("a.txt:1: hit\na.txt:2: hit");
  expect(text(output)).toContain("Match limit of 2 reached");
  expect(text(output)).toContain("offset=0");
  expect(text(output)).toContain("re-searches a.txt");
});

test("grep glob filters files without counting them against the cap", async () => {
  const files: Record<string, string> = { "src/app.ts": "needle" };
  for (let index = 0; index < 5; index += 1) files[`notes/${index}.md`] = "needle";
  const grep = tool(memoryWorkspace(files), "grep", 1);

  const output = await grep.execute("g", { query: "needle", glob: "*.ts" });

  expect(text(output)).toBe("src/app.ts:1: needle");
});

test("grep can search inside an ignored folder when it is the requested path", async () => {
  const grep = tool(memoryWorkspace({ "dist/out.js": "needle", "src/a.ts": "" }), "grep", 10);

  const output = await grep.execute("g", { query: "needle", path: "dist" });

  expect(text(output)).toBe("dist/out.js:1: needle");
});

test("grep accepts a single file path", async () => {
  const grep = tool(memoryWorkspace({ "src/a.ts": "one\nneedle" }), "grep", 10);

  const output = await grep.execute("g", { query: "needle", path: "src/a.ts" });

  expect(text(output)).toBe("src/a.ts:2: needle");
});

test("glob pages through matches with offset", async () => {
  const glob = tool(memoryWorkspace({ "a.ts": "", "b.ts": "", "c.ts": "", "d.md": "" }), "glob", 1);

  const first = await glob.execute("g1", { pattern: "*.ts", limit: 2 });
  expect(text(first)).toBe(
    "a.ts\nb.ts\n[Showing matches 1-2; more files match. Use offset=2 to continue, or narrow the pattern/path.]",
  );
  expect(first.details).toMatchObject({ count: 2, truncated: true });

  const second = await glob.execute("g2", { pattern: "*.ts", limit: 2, offset: 2 });
  expect(text(second)).toBe("c.ts");
  expect(second.details).toMatchObject({ truncated: false });
});

test("glob is not limited by the grep file cap", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 30; index += 1) files[`f${String(index).padStart(2, "0")}.txt`] = "";
  files["zz.vue"] = "";
  const glob = tool(memoryWorkspace(files), "glob", 5);

  const output = await glob.execute("g", { pattern: "**/*.vue" });

  expect(text(output)).toBe("zz.vue");
});

test("glob matches dotfiles and names the noise folders it skipped on disk", async () => {
  const glob = tool(
    memoryWorkspace({
      ".github/workflows/ci.yml": "",
      "config.yml": "",
      "node_modules/pkg/x.yml": "",
    }),
    "glob",
    10,
  );

  const output = await glob.execute("g", { pattern: "**/*.yml" });

  expect(text(output)).toBe(
    ".github/workflows/ci.yml\nconfig.yml\n[Skipped folders: node_modules. Pass one as path to search inside it.]",
  );
});

test("glob says what Acode's index leaves out", async () => {
  const fileIndex = {
    supports: () => true,
    whenReady: async () => undefined,
    scan: async () => undefined,
    query: async () => ({
      entries: [{ path: "project/src/a.ts", name: "a.ts", isFile: true, isDirectory: false }],
      hasMore: false,
      cursor: null,
    }),
  };
  const settings = {
    value: {
      fileBrowser: { showHiddenFiles: false },
      excludeFolders: ["**/node_modules/**", "**/vendor/**", "**/*.egg-info/**"],
    },
  };
  vi.stubGlobal("acode", {
    joinUrl: (root: string, path: string) => `${root}/${path}`,
    require: (name: string) =>
      name === "fileIndex" ? fileIndex : name === "settings" ? settings : undefined,
  });
  const glob = tool(new AcodeWorkspace(ROOT, "project"), "glob", 10);

  const output = await glob.execute("g", { pattern: "**/*.yml" });

  expect(text(output)).toBe(
    "No files matched **/*.yml in 1 files in the workspace.\n" +
      "[Not searched: hidden (dot) files and folders and excluded folders (node_modules, vendor), " +
      "which Acode's file index leaves out. Use list_dir, or pass one as path, to look inside it.]",
  );
});

test("list_dir shows folders first with trailing slashes and hidden files", async () => {
  const list = tool(
    memoryWorkspace({ "src/a.ts": "", ".env": "", "README.md": "", "lib/b.ts": "" }),
    "list_dir",
    10,
  );

  const output = await list.execute("l", {});

  expect(text(output)).toBe("lib/\nsrc/\n.env\nREADME.md");
});

test("list_dir paginates large folders", async () => {
  const list = tool(memoryWorkspace({ "a.txt": "", "b.txt": "", "c.txt": "" }), "list_dir", 10);

  const output = await list.execute("l", { limit: 2 });

  expect(text(output)).toBe("a.txt\nb.txt\n[Showing entries 1-2 of 3. Use offset=2 to continue.]");
});

test("list_dir explains when the path is a file", async () => {
  const list = tool(memoryWorkspace({ "src/a.ts": "" }), "list_dir", 10);

  await expect(list.execute("l", { path: "src/a.ts" })).rejects.toThrow(
    "src/a.ts is a file, not a directory. Use read_file to read it.",
  );
});

test("list_dir times out instead of hanging when a provider never answers", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("acode", {
      joinUrl: (root: string, path: string) => `${root}/${path}`,
      require: () => undefined,
      fsOperation: () => ({ lsDir: () => new Promise(() => undefined) }),
    });
    const list = tool(new AcodeWorkspace(ROOT, "project"), "list_dir", 10);

    const pending = list.execute("l", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(((await pending) as Error).message).toBe(
      "Cannot list the workspace root: Listing the workspace root did not finish within 30s.",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("list_dir stops waiting when the run is aborted", async () => {
  vi.stubGlobal("acode", {
    joinUrl: (root: string, path: string) => `${root}/${path}`,
    require: () => undefined,
    fsOperation: () => ({ lsDir: () => new Promise(() => undefined) }),
  });
  const list = tool(new AcodeWorkspace(ROOT, "project"), "list_dir", 10);
  const controller = new AbortController();

  const pending = list.execute("l", {}, controller.signal);
  controller.abort();

  await expect(pending).rejects.toThrow("Operation aborted");
});

test("list_dir reports a missing folder instead of an empty one", async () => {
  const list = tool(memoryWorkspace({ "src/a.ts": "" }), "list_dir", 10);

  await expect(list.execute("l", { path: "missing" })).rejects.toThrow(
    "Cannot list missing: Path not found. Check the path with list_dir or glob.",
  );
});

test("read_file turns Cordova FileError objects into readable messages", async () => {
  const read = tool(memoryWorkspace({ "a.ts": "" }), "read_file", 10);

  const error = await read.execute("r", { path: "nope.ts" }).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Cannot read nope.ts: Path not found. Check the path with list_dir or glob.",
  );
});

test("tools never surface [object Object] for non-Error rejections", async () => {
  vi.stubGlobal("acode", {
    joinUrl: (root: string, path: string) => `${root}/${path}`,
    require: () => undefined,
    fsOperation: () => ({
      lsDir: () => Promise.reject({ reason: "denied" }),
      stat: () => Promise.reject({ code: 2 }),
    }),
  });
  const list = tool(new AcodeWorkspace(ROOT, "project"), "list_dir", 10);

  await expect(list.execute("l", { path: "src" })).rejects.toThrow(
    "Cannot list src: Security error.",
  );
  await expect(list.execute("l", {})).rejects.toThrow(
    'Cannot list the workspace root: {"reason":"denied"}.',
  );
});

test("edit_file keeps $ patterns in the replacement text literally", async () => {
  const files = { "a.js": "const out = input;\n" };
  const edit = tool(memoryWorkspace(files), "edit_file", 10);

  await edit.execute("e", {
    path: "a.js",
    edits: [{ oldText: "input;", newText: 'input.replace(/x/, "$&!$1");' }],
  });

  expect(files["a.js"]).toBe('const out = input.replace(/x/, "$&!$1");\n');
});

test("edit_file matches LF edits against CRLF files and keeps CRLF", async () => {
  const files = { "win.txt": "one\r\ntwo\r\nthree\r\n" };
  const edit = tool(memoryWorkspace(files), "edit_file", 10);

  const output = await edit.execute("e", {
    path: "win.txt",
    edits: [{ oldText: "one\ntwo", newText: "one\n2" }],
  });

  expect(files["win.txt"]).toBe("one\r\n2\r\nthree\r\n");
  expect(output.details).toMatchObject({ operation: "edit", path: "win.txt", target: "disk" });
  expect((output.details as { diff?: string }).diff).toBeTruthy();
});

test("edit_file applies several edits in one call", async () => {
  const files = { "a.ts": "let a = 1;\nlet b = 2;\nlet c = 3;\n" };
  const edit = tool(memoryWorkspace(files), "edit_file", 10);

  const output = await edit.execute("e", {
    path: "a.ts",
    edits: [
      { oldText: "let a = 1;", newText: "const a = 1;" },
      { oldText: "let c = 3;", newText: "const c = 3;" },
    ],
  });

  expect(files["a.ts"]).toBe("const a = 1;\nlet b = 2;\nconst c = 3;\n");
  expect(text(output)).toBe("Successfully replaced 2 block(s) in a.ts.");
  expect(output.details).toMatchObject({ count: 2 });
});

test("edit_file accepts old_string/new_string arguments", () => {
  const edit = tool(memoryWorkspace({}), "edit_file", 10);

  expect(edit.prepareArguments?.({ path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
    path: "a.ts",
    edits: [{ oldText: "x", newText: "y" }],
  });
});

test("edit_file explains a missing file and an unmatched edit", async () => {
  const edit = tool(memoryWorkspace({ "a.ts": "hello" }), "edit_file", 10);

  await expect(
    edit.execute("e1", { path: "nope.ts", edits: [{ oldText: "a", newText: "b" }] }),
  ).rejects.toThrow("Could not edit nope.ts: Path not found");
  await expect(
    edit.execute("e2", { path: "a.ts", edits: [{ oldText: "absent", newText: "b" }] }),
  ).rejects.toThrow(/a\.ts/);
});

test("edit_file writes into an open editor buffer without saving", async () => {
  const buffer = { value: "draft text" };
  const openFile = {
    loaded: true,
    id: "f1",
    readOnly: false,
    session: {
      getValue: () => buffer.value,
      setValue: (value: string) => {
        buffer.value = value;
      },
    },
  };
  const edit = tool(memoryWorkspace({ "notes.md": "on disk" }), "edit_file", 10);
  vi.stubGlobal("editorManager", {
    getFile: (uri: string) => (uri.endsWith("/notes.md") ? openFile : undefined),
    activeFile: undefined,
    emit: () => undefined,
    files: [],
  });

  const output = await edit.execute("e", {
    path: "notes.md",
    edits: [{ oldText: "draft", newText: "final" }],
  });

  expect(buffer.value).toBe("final text");
  expect(output.details).toMatchObject({ target: "buffer" });
  expect(text(output)).toContain("unsaved buffer");
});

test("describeError handles Cordova and DOM error shapes", () => {
  expect(describeError({ code: 1 })).toBe("Path not found");
  expect(describeError({ code: 5, message: "File encoding error" })).toBe("File encoding error");
  expect(describeError({ target: { error: { code: 4 } } })).toBe("File not readable");
  expect(describeError("boom")).toBe("boom");
  expect(describeError(new Error("bad"))).toBe("bad");
  expect(describeError({})).toBe("Unknown error");
  expect(describeError(undefined)).toBe("Unknown error");
});

function tool(workspace: AcodeWorkspace, name: string, maxWalkFiles: number) {
  return createWorkspaceTools(workspace, { maxWalkFiles: () => maxWalkFiles }).find(
    (candidate) => candidate.name === name,
  )!;
}

function text(output: { content: Array<{ type: string; text?: string }> }): string {
  return output.content[0]?.text ?? "";
}

/** A real AcodeWorkspace over an in-memory tree served through `acode.fsOperation`. */
function memoryWorkspace(files: Record<string, string>): AcodeWorkspace {
  const directories = new Set([""]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1)
      directories.add(parts.slice(0, depth).join("/"));
  }
  const relative = (uri: string) => uri.slice(ROOT.length).replace(/^\/+/, "");
  const notFound = () => Promise.reject({ code: 1, message: "Path not found" });
  vi.stubGlobal("acode", {
    joinUrl: (root: string, path: string) => `${root}/${path}`,
    require: () => undefined,
    fsOperation: (uri: string) => {
      const path = relative(uri);
      return {
        lsDir: async () => {
          // Acode's internalFs throws inside a Cordova callback for files, so the promise never settles.
          if (path in files) return new Promise(() => undefined);
          if (!directories.has(path)) return notFound();
          const prefix = path ? `${path}/` : "";
          const children = new Set<string>();
          for (const candidate of [...Object.keys(files), ...directories]) {
            if (!candidate.startsWith(prefix) || candidate === path) continue;
            children.add(candidate.slice(prefix.length).split("/")[0]!);
          }
          return [...children].map((name) => {
            const child = prefix + name;
            const isDirectory = directories.has(child);
            return { name, url: `${ROOT}/${child}`, isDirectory, isFile: !isDirectory };
          });
        },
        readFile: async () => (path in files ? files[path] : notFound()),
        exists: async () => path in files || directories.has(path),
        writeFile: async (content: string) => {
          files[path] = content;
        },
        stat: async () => {
          if (path in files) return { isFile: true, isDirectory: false, size: files[path]!.length };
          if (directories.has(path)) return { isFile: false, isDirectory: true, size: 0 };
          return notFound();
        },
      };
    },
  });
  return new AcodeWorkspace(ROOT, "project");
}
