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
