import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type AgentTool,
	type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";

const MAX_TIMEOUT_SECONDS = 2_147_483.647;
const UPDATE_THROTTLE_MS = 100;

type BashDetails = {
	truncation?: BashTruncation;
};

type BashTruncation = {
	truncatedBy: "lines" | "bytes";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
};

type BashResult = AgentToolResult<BashDetails>;

type TerminalExecutor = {
	start(command: string, onData: (type: string, data: string) => void, alpine?: boolean): Promise<string>;
	stop(uuid: string): Promise<unknown>;
};

/**
 * Create Pi's bash-shaped tool only when this workspace is backed by Acode
 * Terminal's own filesystem. Ordinary SAF, local-storage, FTP, and SFTP roots
 * deliberately return no tool because Alpine cannot address those files by
 * their Acode paths.
 */
export function createTerminalBashTool(workspace: AcodeWorkspace): AgentTool<any> | undefined {
	const cwd = resolveTerminalWorkingDirectory(workspace.info.rootUri);
	const executor = terminalExecutor();
	if (!cwd || !executor) return undefined;

	return {
		name: "bash",
		label: "bash",
		description:
			`Run Bash with the active terminal workspace already set as cwd. Returns stdout and stderr, keeping the last ` +
			`${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1_024}KB. Optional timeout is in seconds.`,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal, onUpdate) => {
			const input = params as { command?: string; timeout?: number };
			const command = String(input.command ?? "");
			if (!command.trim()) throw new Error("Bash command cannot be empty.");
			if (command.includes("\0")) throw new Error("Bash command contains a null byte.");
			validateTimeout(input.timeout);
			if (signal?.aborted) throw new Error("Command aborted");

			const output = new BashOutputBuffer();
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let lastUpdateAt = 0;
			let updateDirty = false;
			const emitUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				onUpdate(formatSnapshot(output.snapshot(), true));
			};
			const scheduleUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					if (updateTimer) clearTimeout(updateTimer);
					updateTimer = undefined;
					emitUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitUpdate();
				}, delay);
			};

				const wrapped = `bash -lc ${shellQuote(`cd -- ${shellQuote(cwd)} && ${command}`)}`;
			try {
				let exitCode: number;
				try {
					exitCode = await runTerminalCommand(executor, wrapped, input.timeout, signal, (data) => {
						output.append(data);
						scheduleUpdate();
					});
				} catch (error) {
					const status = error instanceof Error ? error.message : String(error);
					const snapshot = formatSnapshot(output.snapshot());
					const text = snapshot.content.find((part) => part.type === "text")?.text ?? "";
					throw new Error(appendStatus(text === "(no output)" ? "" : text, status));
				}
				if (updateTimer) clearTimeout(updateTimer);
				updateTimer = undefined;
				updateDirty = true;
				emitUpdate();
				const snapshot = output.snapshot();
				if (exitCode !== 0) {
					const text = formatSnapshot(snapshot).content.find((part) => part.type === "text")?.text ?? "";
					throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
				}
				return formatSnapshot(snapshot);
			} catch (error) {
				if (updateTimer) clearTimeout(updateTimer);
				throw error;
			}
		},
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

function terminalPublicSafPath(uri: string): string | undefined {
	const separator = uri.indexOf("::");
	const raw = separator >= 0
		? uri.slice(separator + 2)
		: uri.slice(uri.lastIndexOf("/") + 1);
	const docId = decodeSafe(raw).replace(/\/+$/, "");
	const publicMarker = "/files/public";
	const markerIndex = docId.indexOf(publicMarker);
	if (markerIndex >= 0) return joinTerminalPath("/public", docId.slice(markerIndex + publicMarker.length));
	if (docId === "/public" || docId.startsWith("/public/")) return joinTerminalPath("/public", docId.slice("/public".length));
	if (docId === "public:" || docId.startsWith("public:")) return joinTerminalPath("/public", docId.slice("public:".length));
	return undefined;
}

function terminalFilePath(path: string): string | undefined {
	const normalized = path.replace(/\/+$/, "") || "/";
	const filesMarker = "/files/";
	const markerIndex = normalized.lastIndexOf(filesMarker);
	if (markerIndex < 0) return undefined;
	const packagePath = normalized.slice(0, markerIndex);
	if (!/\/data\/(?:user\/0|data)\/com\.foxdebug\.acode(?:free)?$/i.test(packagePath)) return undefined;
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
	return value && typeof value.start === "function" && typeof value.stop === "function" ? value : undefined;
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
}

function runTerminalCommand(
	executor: TerminalExecutor,
	command: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onData: (data: string) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let uuid: string | undefined;
		let settled = false;
		let stopReason: "abort" | "timeout" | undefined;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", abort);
		};
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (stopReason === "abort") reject(new Error("Command aborted"));
			else if (stopReason === "timeout") reject(new Error(`Command timed out after ${timeoutSeconds} seconds`));
			else resolve(exitCode);
		};
		const stop = (reason: "abort" | "timeout") => {
			if (settled || stopReason) return;
			stopReason = reason;
			if (!uuid) return;
			void executor.stop(uuid).then(() => finish(1), (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		};
		const abort = () => stop("abort");
		signal?.addEventListener("abort", abort, { once: true });
		if (timeoutSeconds !== undefined) timeoutHandle = setTimeout(() => stop("timeout"), timeoutSeconds * 1_000);

		void executor.start(command, (type, data) => {
			if (settled) return;
			if (type === "stderr" && /proot warning/i.test(data)) return;
			if (type === "stdout" || type === "stderr" || type === "unknown") onData(String(data));
			if (type === "exit") finish(Number.parseInt(String(data), 10) || 0);
		}, true).then((id) => {
			uuid = id;
			if (stopReason) {
				void executor.stop(id).then(() => finish(1), (error) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			}
		}, (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

class BashOutputBuffer {
	#lines: string[] = [];
	#retainedBytes = 0;
	#totalBytes = 0;
	#totalLines = 0;

	append(value: string): void {
		const line = String(value).replace(/[\r\n]+$/, "");
		this.#totalBytes += utf8Bytes(line) + (this.#totalLines > 0 ? 1 : 0);
		this.#totalLines += 1;
		this.#lines.push(line);
		this.#retainedBytes += utf8Bytes(line) + (this.#lines.length > 1 ? 1 : 0);
		while (this.#lines.length > DEFAULT_MAX_LINES + 1 || (this.#retainedBytes > DEFAULT_MAX_BYTES * 2 && this.#lines.length > 1)) {
			const removed = this.#lines.shift() ?? "";
			this.#retainedBytes -= utf8Bytes(removed) + (this.#lines.length > 0 ? 1 : 0);
		}
		if (this.#lines.length === 1 && this.#retainedBytes > DEFAULT_MAX_BYTES * 2) {
			const tail = utf8Tail(this.#lines[0]!, DEFAULT_MAX_BYTES * 2);
			this.#lines[0] = tail;
			this.#retainedBytes = utf8Bytes(tail);
		}
	}

	snapshot(): { content: string; truncation?: BashTruncation } {
		const selected: string[] = [];
		let outputBytes = 0;
		let lastLinePartial = false;
		for (let index = this.#lines.length - 1; index >= 0 && selected.length < DEFAULT_MAX_LINES; index -= 1) {
			const line = this.#lines[index]!;
			const separator = selected.length ? 1 : 0;
			const lineBytes = utf8Bytes(line);
			if (outputBytes + separator + lineBytes > DEFAULT_MAX_BYTES) {
				if (!selected.length) {
					const tail = utf8Tail(line, DEFAULT_MAX_BYTES);
					selected.unshift(tail);
					outputBytes = utf8Bytes(tail);
					lastLinePartial = true;
				}
				break;
			}
			selected.unshift(line);
			outputBytes += separator + lineBytes;
		}
		const content = selected.join("\n");
		const truncated = this.#totalLines > selected.length || this.#totalBytes > outputBytes;
		if (!truncated) return { content };
		return {
			content,
			truncation: {
				truncatedBy: selected.length >= DEFAULT_MAX_LINES ? "lines" : "bytes",
				totalLines: this.#totalLines,
				totalBytes: this.#totalBytes,
				outputLines: selected.length,
				outputBytes,
				lastLinePartial,
			},
		};
	}
}

function formatSnapshot(
	snapshot: { content: string; truncation?: BashTruncation },
	partial = false,
): BashResult {
	let text = snapshot.content || (partial ? "" : "(no output)");
	const truncation = snapshot.truncation;
	if (truncation) {
		const startLine = Math.max(1, truncation.totalLines - truncation.outputLines + 1);
		if (truncation.lastLinePartial) {
			text += `\n\n[Showing the last ${(truncation.outputBytes / 1_024).toFixed(1)}KB of output (50KB limit).]`;
		} else {
			const reason = truncation.truncatedBy === "bytes" ? " (50KB limit)" : "";
			text += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}${reason}.]`;
		}
	}
	return {
		content: text ? [{ type: "text", text }] : [],
		details: { truncation },
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function utf8Tail(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return new TextDecoder().decode(bytes.subarray(start));
}
