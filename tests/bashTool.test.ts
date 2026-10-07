import { afterEach, expect, test, vi } from "vitest";
import { MutationGate } from "../src/permissions/mutationGate.ts";
import { createWorkspaceTools } from "../src/tools/createTools.ts";
import { resolveTerminalWorkingDirectory } from "../src/tools/terminalShell.ts";
import { WorkspaceExecutionEnv } from "../src/tools/workspaceEnv.ts";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace.ts";
import { runTool } from "./toolHarness.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("maps only Acode Terminal public and Alpine workspace roots", () => {
  expect(
    resolveTerminalWorkingDirectory(
      "content://com.foxdebug.acode.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acode%2Ffiles%2Fpublic::/data/user/0/com.foxdebug.acode/files/public/demo",
    ),
  ).toBe("/public/demo");
  expect(
    resolveTerminalWorkingDirectory(
      "content://com.foxdebug.acodefree.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acodefree%2Ffiles%2Fpublic",
    ),
  ).toBe("/public");
  expect(
    resolveTerminalWorkingDirectory("file:///data/user/0/com.foxdebug.acode/files/public/project"),
  ).toBe("/public/project");
  expect(
    resolveTerminalWorkingDirectory(
      "file:///data/user/0/com.foxdebug.acode/files/alpine/workspace",
    ),
  ).toBe("/workspace");
  expect(
    resolveTerminalWorkingDirectory(
      "content://com.android.externalstorage.documents/tree/primary%3ADocuments",
    ),
  ).toBeUndefined();
  expect(resolveTerminalWorkingDirectory("file:///sdcard/project")).toBeUndefined();
  expect(resolveTerminalWorkingDirectory("sftp://example.com/project")).toBeUndefined();
  expect(
    resolveTerminalWorkingDirectory(
      "content://com.foxdebug.acode.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acode%2Ffiles%2Fpublic::/data/user/0/com.foxdebug.acode/files/public/../../files/alpine/etc",
    ),
  ).toBeUndefined();
  expect(
    resolveTerminalWorkingDirectory("file:///data/user/0/another.app/files/public/project"),
  ).toBeUndefined();
  expect(
    resolveTerminalWorkingDirectory(
      "file:///data/user/0/com.foxdebug.acode/files/alpine/%2e%2e/databases",
    ),
  ).toBeUndefined();
});

test("does not offer a shell outside terminal workspaces", () => {
  vi.stubGlobal("Executor", fakeExecutor());
  expect(new WorkspaceExecutionEnv(workspace("sftp://example.com/project")).shell).toBeUndefined();
  expect(
    new WorkspaceExecutionEnv(
      workspace("content://com.android.externalstorage.documents/tree/primary%3Aproject"),
    ).shell,
  ).toBeUndefined();
});

test("runs Pi's bash tool in Acode Terminal from the mapped workspace cwd", async () => {
  let started = "";
  const executor = fakeExecutor((command, onData) => {
    started = command;
    onData("stderr", "proot warning: binding host rootfs");
    onData("stdout", "hello");
    onData("stderr", "warning");
    onData("exit", "0");
  });
  vi.stubGlobal("Executor", executor);
  const result = await bash("file:///data/user/0/com.foxdebug.acode/files/public/project", {
    command: "pwd && echo ok",
  });

  expect(started).toContain("cd --");
  expect(started).toContain("/public/project");
  expect(started).toContain("pwd && echo ok");
  expect(result.content[0]?.text).toBe("hello\nwarning\n");
  expect(executor.stopped).toEqual(["process-1"]);
  expect(executor.stoppedService).toBe(1);
});

test("reports non-zero exits as tool errors", async () => {
  vi.stubGlobal(
    "Executor",
    fakeExecutor((_command, onData) => {
      onData("stderr", "failed");
      onData("exit", "7");
    }),
  );
  await expect(
    bash("file:///data/user/0/com.foxdebug.acode/files/public", { command: "false" }),
  ).rejects.toThrow("Command exited with code 7");
});

test("stops timed-out commands", async () => {
  vi.useFakeTimers();
  const executor = fakeExecutor();
  executor.start = async (_command: string, onData: (type: string, data: string) => void) => {
    onData("stdout", "still running");
    return "process-timeout";
  };
  vi.stubGlobal("Executor", executor);
  const execution = bash("file:///data/user/0/com.foxdebug.acode/files/public", {
    command: "sleep 10",
    timeout: 1,
  });
  const rejected = expect(execution).rejects.toThrow("Command timed out after 1 seconds");
  await vi.advanceTimersByTimeAsync(1_000);

  await rejected;
  expect(executor.stopped).toContain("process-timeout");
  expect(executor.stoppedService).toBe(1);
  vi.useRealTimers();
});

test("stops the executor service after an agent-started command when nothing else is running", async () => {
  const executor = fakeExecutor((_command, onData) => onData("exit", "0"));
  vi.stubGlobal("Executor", executor);
  await bash("file:///data/user/0/com.foxdebug.acode/files/public", { command: "true" });
  expect(executor.stopped).toEqual(["process-1"]);
  expect(executor.stoppedService).toBe(1);
});

test("does not stop the executor service when other terminal processes are already running", async () => {
  const executor = fakeExecutor((_command, onData) => onData("exit", "0"));
  executor.listProcesses = async () => [{ id: "user-terminal" }];
  vi.stubGlobal("Executor", executor);
  await bash("file:///data/user/0/com.foxdebug.acode/files/public", { command: "true" });
  expect(executor.stopped).toEqual(["process-1"]);
  expect(executor.stoppedService).toBe(0);
});

test("requires separate shell approval even in allow-edits mode", async () => {
  const gate = new MutationGate();
  const first = gate.request(
    "bash",
    { command: "npm test" },
    workspace("file:///data/user/0/com.foxdebug.acode/files/public"),
    "allow-edits",
  );
  await Promise.resolve();
  expect(gate.pending).toMatchObject({
    toolName: "bash",
    title: "Run terminal command",
    preview: "npm test",
  });
  gate.resolve("allow-session");
  expect(await first).toEqual({});
  expect(
    await gate.request(
      "bash",
      { command: "npm run build" },
      workspace("file:///data/user/0/com.foxdebug.acode/files/public"),
      "ask",
    ),
  ).toEqual({});
  gate.dispose();
});

async function bash(rootUri: string, args: { command: string; timeout?: number }) {
  const ws = workspace(rootUri);
  const env = new WorkspaceExecutionEnv(ws);
  const tool = createWorkspaceTools(ws, { maxWalkFiles: () => 10, bash: true }).find(
    (candidate) => candidate.name === "bash",
  )!;
  return runTool(tool, args, { env });
}

function workspace(rootUri: string): AcodeWorkspace {
  return {
    info: { id: "w", name: "project", rootUri, scheme: rootUri.split(":", 1)[0]!, remote: false },
  } as AcodeWorkspace;
}

function fakeExecutor(
  run?: (command: string, onData: (type: string, data: string) => void) => void,
) {
  const executor = {
    stopped: [] as string[],
    stoppedService: 0,
    start: async (
      command: string,
      onData: (type: string, data: string) => void,
      alpine?: boolean,
    ) => {
      expect(alpine).toBe(true);
      queueMicrotask(() => run?.(command, onData));
      return "process-1";
    },
    stop: async (uuid: string) => {
      executor.stopped.push(uuid);
    },
    listProcesses: async () => [] as Array<{ id?: string }>,
    stopService: async () => {
      executor.stoppedService += 1;
    },
  };
  return executor;
}
