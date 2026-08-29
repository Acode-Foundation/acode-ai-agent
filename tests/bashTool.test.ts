import { afterEach, expect, test, vi } from "vitest";
import { createTerminalBashTool, resolveTerminalWorkingDirectory } from "../src/tools/bash.ts";
import { MutationGate } from "../src/permissions/mutationGate.ts";
import type { AcodeWorkspace } from "../src/workspace/acodeWorkspace.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("maps only Acode Terminal public and Alpine workspace roots", () => {
	expect(resolveTerminalWorkingDirectory(
		"content://com.foxdebug.acode.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acode%2Ffiles%2Fpublic::/data/user/0/com.foxdebug.acode/files/public/demo",
	)).toBe("/public/demo");
	expect(resolveTerminalWorkingDirectory(
		"content://com.foxdebug.acodefree.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acodefree%2Ffiles%2Fpublic",
	)).toBe("/public");
	expect(resolveTerminalWorkingDirectory("file:///data/user/0/com.foxdebug.acode/files/public/project")).toBe("/public/project");
	expect(resolveTerminalWorkingDirectory("file:///data/user/0/com.foxdebug.acode/files/alpine/workspace")).toBe("/workspace");
	expect(resolveTerminalWorkingDirectory("content://com.android.externalstorage.documents/tree/primary%3ADocuments")).toBeUndefined();
	expect(resolveTerminalWorkingDirectory("file:///sdcard/project")).toBeUndefined();
	expect(resolveTerminalWorkingDirectory("sftp://example.com/project")).toBeUndefined();
	expect(resolveTerminalWorkingDirectory(
		"content://com.foxdebug.acode.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acode%2Ffiles%2Fpublic::/data/user/0/com.foxdebug.acode/files/public/../../files/alpine/etc",
	)).toBeUndefined();
	expect(resolveTerminalWorkingDirectory("file:///data/user/0/another.app/files/public/project")).toBeUndefined();
	expect(resolveTerminalWorkingDirectory("file:///data/user/0/com.foxdebug.acode/files/alpine/%2e%2e/databases")).toBeUndefined();
});

test("does not register bash outside terminal workspaces", () => {
	vi.stubGlobal("Executor", fakeExecutor());
	expect(createTerminalBashTool(workspace("sftp://example.com/project"))).toBeUndefined();
	expect(createTerminalBashTool(workspace("content://com.android.externalstorage.documents/tree/primary%3Aproject"))).toBeUndefined();
});

test("streams a Pi-shaped bash command from the mapped workspace cwd", async () => {
	let started = "";
	const executor = fakeExecutor((command, onData) => {
		started = command;
		onData("stderr", "proot warning: binding host rootfs");
		onData("stdout", "hello");
		onData("stderr", "warning");
		onData("exit", "0");
	});
	vi.stubGlobal("Executor", executor);
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public/project"))!;
	const updates: string[] = [];
	const result = await tool.execute("bash-1", { command: "pwd && echo ok" }, undefined, (update) => {
		const part = update.content[0];
		if (part?.type === "text") updates.push(part.text);
	});

	expect(started).toContain("cd --");
	expect(started).toContain("/public/project");
	expect(started).toContain("pwd && echo ok");
	expect(result.content[0]).toEqual({ type: "text", text: "hello\nwarning" });
	expect(updates.at(-1)).toBe("hello\nwarning");
	expect(executor.stopped).toEqual(["process-1"]);
	expect(executor.stoppedService).toBe(1);
});

test("reports non-zero exits as tool errors with captured output", async () => {
	vi.stubGlobal("Executor", fakeExecutor((_command, onData) => {
		onData("stderr", "failed");
		onData("exit", "7");
	}));
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public"))!;
	await expect(tool.execute("bash-2", { command: "false" })).rejects.toThrow("failed\n\nCommand exited with code 7");
});

test("keeps the tail of output at Pi's line limit", async () => {
	vi.stubGlobal("Executor", fakeExecutor((_command, onData) => {
		for (let line = 1; line <= 2_002; line += 1) onData("stdout", `line ${line}`);
		onData("exit", "0");
	}));
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public"))!;
	const result = await tool.execute("bash-tail", { command: "many-lines" });
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	expect(text).toMatch(/^line 3\nline 4/);
	expect(text).toContain("line 2002\n\n[Showing lines 3-2002 of 2002.]");
});

test("reports the byte limit when it is reached before the line limit", async () => {
	vi.stubGlobal("Executor", fakeExecutor((_command, onData) => {
		for (let line = 1; line <= 2_001; line += 1) onData("stdout", `${line}:${"x".repeat(100)}`);
		onData("exit", "0");
	}));
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public"))!;
	const result = await tool.execute("bash-bytes", { command: "large-output" });
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	expect(result.details?.truncation?.truncatedBy).toBe("bytes");
	expect(text).toMatch(/\(50KB limit\)\.\]$/);
});

test("stops timed-out commands and includes their captured output", async () => {
	vi.useFakeTimers();
	const executor = fakeExecutor();
	executor.start = async (_command: string, onData: (type: string, data: string) => void) => {
		onData("stdout", "still running");
		return "process-timeout";
	};
	vi.stubGlobal("Executor", executor);
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public"))!;
	const execution = tool.execute("bash-3", { command: "sleep 10", timeout: 1 });
	const rejected = expect(execution).rejects.toThrow("still running\n\nCommand timed out after 1 seconds");
	await vi.advanceTimersByTimeAsync(1_000);

	await rejected;
	expect(executor.stopped).toContain("process-timeout");
	expect(executor.stoppedService).toBe(1);
	vi.useRealTimers();
});

test("stops the executor service after an agent-started command when nothing else is running", async () => {
	const executor = fakeExecutor((_command, onData) => onData("exit", "0"));
	vi.stubGlobal("Executor", executor);
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public"))!;
	await tool.execute("bash-cleanup", { command: "true" });
	expect(executor.stopped).toEqual(["process-1"]);
	expect(executor.stoppedService).toBe(1);
});

test("does not stop the executor service when other terminal processes are already running", async () => {
	const executor = fakeExecutor((_command, onData) => onData("exit", "0"));
	executor.listProcesses = async () => [{ id: "user-terminal" }];
	vi.stubGlobal("Executor", executor);
	const tool = createTerminalBashTool(workspace("file:///data/user/0/com.foxdebug.acode/files/public"))!;
	await tool.execute("bash-shared", { command: "true" });
	expect(executor.stopped).toEqual(["process-1"]);
	expect(executor.stoppedService).toBe(0);
});

test("requires separate shell approval even in allow-edits mode", async () => {
	const gate = new MutationGate();
	const first = gate.request("bash", { command: "npm test" }, workspace("file:///data/user/0/com.foxdebug.acode/files/public"), "allow-edits");
	await Promise.resolve();
	expect(gate.pending).toMatchObject({ toolName: "bash", title: "Run terminal command", preview: "npm test" });
	gate.resolve("allow-session");
	expect(await first).toEqual({});
	expect(await gate.request("bash", { command: "npm run build" }, workspace("file:///data/user/0/com.foxdebug.acode/files/public"), "ask")).toEqual({});
	gate.dispose();
});

function workspace(rootUri: string): AcodeWorkspace {
	return { info: { id: "w", name: "project", rootUri, scheme: rootUri.split(":", 1)[0]!, remote: false } } as AcodeWorkspace;
}

function fakeExecutor(run?: (command: string, onData: (type: string, data: string) => void) => void) {
	const executor = {
		stopped: [] as string[],
		stoppedService: 0,
		start: async (command: string, onData: (type: string, data: string) => void, alpine?: boolean) => {
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
