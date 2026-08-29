import {
	AgentHarness,
	AgentHarnessError,
	InMemorySessionStorage,
	Session,
	type AgentEvent,
	type AgentHarnessEvent,
	type AgentHarnessTool,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { messagePlainText } from "../session/sessionText";
import { MutationGate } from "../permissions/mutationGate";
import type { AgentSettings } from "../core/types";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { clampThinkingLevel } from "../providers/thinkingLevels";
import { presentTool } from "../ui/transcript";
import { applyToolBudget } from "./filterTools";
import { buildChildSystemPrompt } from "./prompt";
import type { SubagentDefinition, SubagentWorkItem } from "./types";

export type ChildProgress = {
	lastTool?: string;
	toolCount: number;
	work: SubagentWorkItem[];
	output: string;
};

export type ChildLaunchRequest = {
	id: string;
	agent: SubagentDefinition;
	task: string;
	briefing?: string;
	parentPrompt?: string;
	tools: AgentTool[];
	models: Models;
	model: Model<any>;
	settings: AgentSettings;
	workspace: AcodeWorkspace;
	mutationGate: MutationGate;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?: (progress: ChildProgress) => void;
};

export type ChildResult = {
	status: "completed" | "failed" | "stopped" | "timed_out";
	output: string;
	error?: string;
	toolCount: number;
	work: SubagentWorkItem[];
	modelId: string;
};

export type ChildHandle = {
	stop(): Promise<void>;
	steer(text: string): Promise<void>;
	result: Promise<ChildResult>;
};

export function launchChild(request: ChildLaunchRequest): ChildHandle {
	const abort = new AbortController();
	const timedOut = { value: false };
	const onParentAbort = () => abort.abort();
	request.signal?.addEventListener("abort", onParentAbort, { once: true });
	if (request.signal?.aborted) abort.abort();

	const timer = setTimeout(() => {
		timedOut.value = true;
		abort.abort();
	}, request.timeoutMs);

	let harness: AgentHarness | undefined;
	let unsubscribe: (() => void) | undefined;
	const work = new Map<string, SubagentWorkItem>();
	const progress: ChildProgress = { toolCount: 0, work: [], output: "" };

	const emit = () => request.onProgress?.({
		...progress,
		work: [...work.values()].slice(-24),
	});

	const result = (async (): Promise<ChildResult> => {
		const systemPrompt = await buildChildSystemPrompt({
			agent: request.agent,
			workspace: request.workspace,
			parentPrompt: request.parentPrompt,
			briefing: request.briefing,
		});
		const tools = applyToolBudget(request.tools, request.agent.toolBudget, (count, name) => {
			progress.toolCount = count;
			progress.lastTool = name;
			emit();
		});
		const thinking = clampThinkingLevel(request.model, request.agent.thinking ?? request.settings.thinkingLevel);
		const session = new Session(new InMemorySessionStorage({
			metadata: { id: request.id, createdAt: new Date().toISOString() },
		}));
		harness = new AgentHarness({
			session,
			models: request.models,
			model: request.model,
			thinkingLevel: thinking,
			tools: toHarnessTools(tools),
			resources: { skills: [], promptTemplates: [] },
			retry: {
				enabled: request.settings.retryEnabled,
				maxRetries: Math.min(2, request.settings.retryMaxRetries),
				baseDelayMs: request.settings.retryBaseDelayMs,
			},
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			systemPrompt,
			streamOptions: {
				transport: request.settings.transport,
				timeoutMs: request.settings.providerTimeoutMs,
				maxRetries: request.settings.providerMaxRetries,
				maxRetryDelayMs: request.settings.providerMaxRetryDelayMs,
			},
		});
		unsubscribe = harness.subscribe((event) => {
			onHarnessEvent(event, work, progress);
			emit();
		});
		harness.on("tool_call", async (event) => request.mutationGate.request(
			event.toolName,
			event.input,
			request.workspace,
			request.settings.permissionMode,
			abort.signal,
		));
		const stopChild = () => {
			void harness?.abort().catch(() => undefined);
		};
		abort.signal.addEventListener("abort", stopChild, { once: true });
		if (abort.signal.aborted) stopChild();
		try {
			const message = await harness.prompt(request.task);
			progress.output = assistantText(message) || progress.output;
			if (timedOut.value) return finish("timed_out", progress.output, "Subagent hit its runtime deadline.");
			if (abort.signal.aborted) return finish("stopped", progress.output, "Subagent was stopped.");
			if (message.stopReason === "aborted") return finish("stopped", progress.output, "Subagent was stopped.");
			if (message.stopReason === "error") {
				return finish("failed", progress.output, message.errorMessage?.trim() || "The subagent model request failed.");
			}
			return finish("completed", progress.output);
		} catch (error) {
			if (timedOut.value) return finish("timed_out", progress.output, "Subagent hit its runtime deadline.");
			if (abort.signal.aborted || isAbortError(error)) return finish("stopped", progress.output, "Subagent was stopped.");
			const message = error instanceof Error ? error.message : String(error);
			return finish("failed", progress.output, message);
		} finally {
			abort.signal.removeEventListener("abort", stopChild);
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onParentAbort);
			unsubscribe?.();
			await harness?.abort().catch(() => undefined);
			await harness?.waitForIdle().catch(() => undefined);
		}
	})();

	function finish(status: ChildResult["status"], output: string, error?: string): ChildResult {
		return {
			status,
			output,
			error,
			toolCount: progress.toolCount,
			work: [...work.values()].slice(-24),
			modelId: request.model.id,
		};
	}

	return {
		async stop() {
			abort.abort();
			await harness?.abort().catch(() => undefined);
		},
		async steer(text: string) {
			const next = text.trim();
			if (!next) throw new Error("Steer text cannot be empty.");
			if (!harness) throw new Error("That subagent has not started yet.");
			try {
				await harness.steer(next);
			} catch (error) {
				if (error instanceof AgentHarnessError && error.code === "invalid_state") {
					throw new Error("That subagent is not running.");
				}
				throw error;
			}
		},
		result,
	};
}

function onHarnessEvent(event: AgentHarnessEvent, work: Map<string, SubagentWorkItem>, progress: ChildProgress): void {
	if (!isAgentEvent(event)) return;
	if (event.type === "message_update" && event.message.role === "assistant") {
		const text = assistantText(event.message);
		if (text) progress.output = text;
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const text = assistantText(event.message);
		if (text) progress.output = text;
	}
	if (event.type === "tool_execution_start") {
		const presented = presentTool(event.toolName, sanitizeArgs(event.args));
		work.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			label: presented.label,
			detail: presented.detail,
			status: "running",
		});
		progress.lastTool = event.toolName;
	}
	if (event.type === "tool_execution_update") {
		const item = work.get(event.toolCallId);
		if (item) item.summary = toolResultText(event.partialResult);
	}
	if (event.type === "tool_execution_end") {
		const item = work.get(event.toolCallId);
		if (!item) return;
		item.status = event.isError ? "error" : "done";
		item.summary = toolResultText(event.result);
		const presented = presentTool(item.name, {}, item.summary);
		item.detail = presented.detail ?? item.detail;
	}
}

function toHarnessTools(tools: AgentTool[]): AgentHarnessTool<undefined>[] {
	return tools.map((tool) => ({
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	}));
}

function isAgentEvent(event: AgentHarnessEvent): event is AgentEvent {
	return event.type === "message_start"
		|| event.type === "message_update"
		|| event.type === "message_end"
		|| event.type === "tool_execution_start"
		|| event.type === "tool_execution_update"
		|| event.type === "tool_execution_end";
}

function assistantText(message: AgentMessage): string {
	return messagePlainText(message).trim();
}

function sanitizeArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return {};
	const value = { ...(args as Record<string, unknown>) };
	if ("content" in value) value.content = `[${String(value.content).length} characters]`;
	if ("new_string" in value) value.new_string = `[${String(value.new_string).length} characters]`;
	if ("old_string" in value) value.old_string = `[${String(value.old_string).length} characters]`;
	return value;
}

function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	return content?.find((item) => item.type === "text")?.text?.slice(0, 300) ?? "";
}

function isAbortError(error: unknown): boolean {
	return (error instanceof DOMException && error.name === "AbortError")
		|| (error instanceof AgentHarnessError && error.code === "invalid_state");
}
