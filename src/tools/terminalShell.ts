import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  ok,
  type Result,
  type Shell,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";

type TerminalExecutor = {
  start(
    command: string,
    onData: (type: string, data: string) => void,
    alpine?: boolean,
  ): Promise<string>;
  stop(uuid: string): Promise<unknown>;
  listProcesses?(): Promise<Array<{ id?: string }>>;
  stopService?(): Promise<unknown>;
};

type ExecutorUseState = {
  count: number;
  owns: boolean;
  lock: Promise<void>;
};

const executorUse = new WeakMap<TerminalExecutor, ExecutorUseState>();

/**
 * Pi's `Shell` over Acode Terminal's Alpine executor, so Pi's own `bash` tool runs
 * commands for the workspace. Only workspaces backed by Acode Terminal's filesystem get
 * one: SAF, local-storage, FTP, and SFTP roots return undefined because Alpine cannot
 * address those files by their Acode paths.
 */
export function createTerminalShell(rootUri: string): (Shell & { root: string }) | undefined {
  const root = resolveTerminalWorkingDirectory(rootUri);
  const executor = terminalExecutor();
  if (!root || !executor) return undefined;
  return {
    root,
    async exec(
      command: string | readonly string[],
      options: ShellExecOptions | undefined,
      context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
      const script = typeof command === "string" ? command : command.map(shellQuote).join(" ");
      if (!script.trim()) return err(new ExecutionError("spawn_error", "Command cannot be empty."));
      if (script.includes("\0"))
        return err(new ExecutionError("spawn_error", "Command contains a null byte."));
      const cwd = terminalCwd(root, options?.cwd);
      if (!cwd)
        return err(new ExecutionError("spawn_error", "Working directory escapes the workspace."));
      const exports = Object.entries(options?.env ?? {})
        .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .map(([key, value]) => `export ${key}=${shellQuote(value)}; `)
        .join("");
      const wrapped = `bash -lc ${shellQuote(`${exports}cd -- ${shellQuote(cwd)} && ${script}`)}`;
      try {
        const exitCode = await runTerminalCommand(
          executor,
          wrapped,
          options?.timeout,
          context.abortSignal,
          (stream, text) => options?.onOutput?.(text, context, { stream }),
        );
        return ok({ exitCode });
      } catch (error) {
        if (error instanceof ExecutionError) return err(error);
        return err(
          new ExecutionError(
            "spawn_error",
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error : undefined,
          ),
        );
      }
    },
    async cleanup(): Promise<void> {},
  };
}

/** Map an Acode Terminal workspace URI to the matching path inside Alpine. */
export function resolveTerminalWorkingDirectory(rootUri: string): string | undefined {
  const value = String(rootUri ?? "").split(/[?#]/, 1)[0] ?? "";
  if (!value) return undefined;
  if (/^content:\/\/com\.foxdebug\.acode(?:free)?\.documents\/tree\//i.test(value)) {
    return terminalPublicSafPath(value);
  }
  if (/^file:\/\//i.test(value)) return terminalFilePath(fileUriPath(value));
  return undefined;
}

/** A workspace-relative `/`-rooted cwd from the environment, mapped below the terminal root. */
function terminalCwd(root: string, cwd: string | undefined): string | undefined {
  const relative = (cwd ?? "/").replace(/^\/+/, "");
  return relative ? joinTerminalPath(root, relative) : root;
}

function terminalPublicSafPath(uri: string): string | undefined {
  const separator = uri.indexOf("::");
  const raw = separator >= 0 ? uri.slice(separator + 2) : uri.slice(uri.lastIndexOf("/") + 1);
  const docId = decodeSafe(raw).replace(/\/+$/, "");
  const publicMarker = "/files/public";
  const markerIndex = docId.indexOf(publicMarker);
  if (markerIndex >= 0)
    return joinTerminalPath("/public", docId.slice(markerIndex + publicMarker.length));
  if (docId === "/public" || docId.startsWith("/public/"))
    return joinTerminalPath("/public", docId.slice("/public".length));
  if (docId === "public:" || docId.startsWith("public:"))
    return joinTerminalPath("/public", docId.slice("public:".length));
  return undefined;
}

function terminalFilePath(path: string): string | undefined {
  const normalized = path.replace(/\/+$/, "") || "/";
  const filesMarker = "/files/";
  const markerIndex = normalized.lastIndexOf(filesMarker);
  if (markerIndex < 0) return undefined;
  const packagePath = normalized.slice(0, markerIndex);
  if (!/\/data\/(?:user\/0|data)\/com\.foxdebug\.acode(?:free)?$/i.test(packagePath))
    return undefined;
  const withinFiles = normalized.slice(markerIndex + filesMarker.length);
  if (withinFiles === "public" || withinFiles.startsWith("public/")) {
    return joinTerminalPath("/public", withinFiles.slice("public".length));
  }
  if (withinFiles === "alpine" || withinFiles.startsWith("alpine/")) {
    return joinTerminalPath("/", withinFiles.slice("alpine".length));
  }
  return undefined;
}

function fileUriPath(uri: string): string {
  try {
    return decodeSafe(new URL(uri).pathname);
  } catch {
    return decodeSafe(uri.replace(/^file:\/\//i, ""));
  }
}

function joinTerminalPath(root: string, suffix: string): string | undefined {
  const relative = decodeSafe(suffix).replace(/^\/+/, "");
  if (relative.split("/").some((part) => part === "..")) return undefined;
  return normalizeTerminalPath(relative ? `${root}/${relative}` : root);
}

function normalizeTerminalPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function terminalExecutor(): TerminalExecutor | undefined {
  const value = (globalThis as typeof globalThis & { Executor?: TerminalExecutor }).Executor;
  return value && typeof value.start === "function" && typeof value.stop === "function"
    ? value
    : undefined;
}

async function runTerminalCommand(
  executor: TerminalExecutor,
  command: string,
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onData: (stream: "stdout" | "stderr", text: string) => void,
): Promise<number> {
  await beginAgentExecutorUse(executor);
  let uuid: string | undefined;
  let started: Promise<string> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      let stopReason: "abort" | "timeout" | undefined;
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stopReason === "abort") reject(new ExecutionError("aborted", "Command aborted"));
        else if (stopReason === "timeout")
          reject(
            new ExecutionError("timeout", `Command timed out after ${timeoutSeconds} seconds`),
          );
        else resolve(exitCode);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const stopStarted = (id: string) => {
        void Promise.resolve(executor.stop(id)).then(() => finish(1), fail);
      };
      const requestStop = (reason: "abort" | "timeout") => {
        if (settled || stopReason) return;
        stopReason = reason;
        if (uuid) stopStarted(uuid);
      };
      const onAbort = () => requestStop("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        requestStop("abort");
        if (!uuid) finish(1);
        return;
      }
      if (timeoutSeconds !== undefined)
        timeoutHandle = setTimeout(() => requestStop("timeout"), timeoutSeconds * 1_000);

      started = executor
        .start(
          command,
          (type, data) => {
            if (settled) return;
            if (type === "stderr" && /proot warning/i.test(data)) return;
            // The executor delivers one line per callback without its newline.
            if (type === "stdout" || type === "unknown")
              onData("stdout", `${String(data).replace(/[\r\n]+$/, "")}\n`);
            if (type === "stderr") onData("stderr", `${String(data).replace(/[\r\n]+$/, "")}\n`);
            if (type === "exit") finish(Number.parseInt(String(data), 10) || 0);
          },
          true,
        )
        .then((id) => {
          uuid = id;
          if (!settled && stopReason) stopStarted(id);
          return id;
        });
      void started.then(() => undefined, fail);
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (!uuid && started) {
      try {
        uuid = await started;
      } catch {
        uuid = undefined;
      }
    }
    if (uuid)
      await Promise.resolve(executor.stop(uuid)).then(
        () => undefined,
        () => undefined,
      );
    await endAgentExecutorUse(executor);
  }
}

function executorUseState(executor: TerminalExecutor): ExecutorUseState {
  let state = executorUse.get(executor);
  if (!state) {
    state = { count: 0, owns: false, lock: Promise.resolve() };
    executorUse.set(executor, state);
  }
  return state;
}

function withExecutorLock<T>(
  executor: TerminalExecutor,
  fn: (state: ExecutorUseState) => Promise<T>,
): Promise<T> {
  const state = executorUseState(executor);
  const run = state.lock.then(() => fn(state));
  state.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The agent starts Acode Terminal's service when idle and stops it again once its own commands end. */
function beginAgentExecutorUse(executor: TerminalExecutor): Promise<void> {
  return withExecutorLock(executor, async (state) => {
    if (state.count === 0) {
      const listed = await listExecutorProcesses(executor);
      state.owns = listed.known && listed.processes.length === 0;
    }
    state.count += 1;
  });
}

function endAgentExecutorUse(executor: TerminalExecutor): Promise<void> {
  return withExecutorLock(executor, async (state) => {
    state.count = Math.max(0, state.count - 1);
    if (state.count > 0 || !state.owns) return;
    state.owns = false;
    const remaining = await listExecutorProcesses(executor);
    if (!remaining.known || remaining.processes.length > 0) return;
    if (typeof executor.stopService !== "function") return;
    try {
      await executor.stopService();
    } catch {}
  });
}

async function listExecutorProcesses(
  executor: TerminalExecutor,
): Promise<{ processes: Array<{ id?: string }>; known: boolean }> {
  if (typeof executor.listProcesses !== "function") return { processes: [], known: false };
  try {
    const processes = await executor.listProcesses();
    return { processes: Array.isArray(processes) ? processes : [], known: true };
  } catch {
    return { processes: [], known: false };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
