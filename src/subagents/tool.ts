import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { SUBAGENT_ACTIONS, type SubagentAction, type SubagentContextMode, type SubagentLaunchSpec } from "./types";
import type { SubagentRuntime } from "./runtime";

type SubagentParams = {
	action?: string;
	agent?: string;
	task?: string;
	tasks?: Array<{ agent?: string; task?: string; context?: string }>;
	chain?: Array<{ agent?: string; task?: string; context?: string }>;
	async?: boolean;
	context?: string;
	id?: string;
	message?: string;
	timeout_ms?: number;
};

type ToolDetails = {
	operation: string;
	agent?: string;
	count?: number;
	path?: string;
};

export function createSubagentTool(runtime: SubagentRuntime): AgentTool<any> {
	return {
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate focused work to an isolated child agent. Use scout for recon, researcher for web/docs, reviewer for read-only review, oracle for a second opinion, worker to implement, or delegate for general work. " +
			"The parent only receives a truncated result plus a run id. Children cannot spawn children. " +
			"Management: action=list|get|status|stop|steer|resume|doctor.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "list, get, status, stop, steer, resume, or doctor. Omit to launch." })),
			agent: Type.Optional(Type.String({ description: "Agent name or alias" })),
			task: Type.Optional(Type.String({ description: "Task for a single child" })),
			tasks: Type.Optional(Type.Array(Type.Object({
				agent: Type.String(),
				task: Type.String(),
				context: Type.Optional(Type.String()),
			}), { description: "Run these children in parallel (max 4, 2 at a time)" })),
			chain: Type.Optional(Type.Array(Type.Object({
				agent: Type.String(),
				task: Type.String(),
				context: Type.Optional(Type.String()),
			}), { description: "Run these children in order, passing each result forward" })),
			async: Type.Optional(Type.Boolean({ description: "Return a receipt and keep working. Default is to wait." })),
			context: Type.Optional(Type.String({ description: "fresh or brief. brief is a compact parent handoff, not the full transcript." })),
			id: Type.Optional(Type.String({ description: "Run id for status, stop, steer, or resume" })),
			message: Type.Optional(Type.String({ description: "Steer or resume text" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Deadline in milliseconds for this launch" })),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal, onUpdate) => {
			const input = params as SubagentParams;
			const progress = (text: string) => onUpdate?.(result(text, { operation: "progress" }));
			const action = parseAction(input.action);
			if (action) return dispatchAction(runtime, action, input, signal, progress);
			return dispatchLaunch(runtime, input, signal, progress);
		},
	};
}

async function dispatchAction(
	runtime: SubagentRuntime,
	action: SubagentAction,
	input: SubagentParams,
	signal: AbortSignal | undefined,
	onProgress: (text: string) => void,
): Promise<AgentToolResult<ToolDetails>> {
	switch (action) {
		case "list":
			return result(runtime.listAgents(), { operation: "list" });
		case "get":
			return result(runtime.getAgent(required(input.agent, "agent")), { operation: "get", agent: input.agent });
		case "status":
			return result(runtime.status(input.id), { operation: "status" });
		case "stop":
			return result(await runtime.stop(required(input.id, "id")), { operation: "stop" });
		case "steer":
			return result(await runtime.steer(required(input.id, "id"), required(input.message, "message")), { operation: "steer" });
		case "resume":
			return result(await runtime.resume(required(input.id, "id"), required(input.message, "message"), { signal, onProgress }), { operation: "resume" });
		case "doctor":
			return result(runtime.doctor(), { operation: "doctor" });
	}
}

async function dispatchLaunch(
	runtime: SubagentRuntime,
	input: SubagentParams,
	signal: AbortSignal | undefined,
	onProgress: (text: string) => void,
): Promise<AgentToolResult<ToolDetails>> {
	const modes = [input.task || input.agent ? "single" : "", input.tasks?.length ? "tasks" : "", input.chain?.length ? "chain" : ""].filter(Boolean);
	if (modes.length > 1) throw new Error("Pass only one of task, tasks, or chain.");
	if (!modes.length) throw new Error("Pass agent+task, tasks, or chain, or an action.");
	if (input.chain?.length) {
		if (input.async) throw new Error("Chains always wait; omit async.");
		const chain = input.chain.map((step) => launchSpec(step.agent, step.task, false, step.context, input.timeout_ms));
		const text = await runtime.launchChain(chain, { signal, onProgress });
		return result(text, { operation: "chain", count: chain.length });
	}
	if (input.tasks?.length) {
		const tasks = input.tasks.map((step) => launchSpec(step.agent, step.task, input.async, step.context ?? input.context, input.timeout_ms));
		const text = await runtime.launchMany(tasks, { signal, onProgress, async: input.async });
		return result(text, { operation: "parallel", count: tasks.length });
	}
	const spec = launchSpec(input.agent, input.task, input.async, input.context, input.timeout_ms);
	const text = await runtime.launch(spec, { signal, onProgress });
	return result(text, { operation: spec.async ? "async" : "run", agent: spec.agent });
}

function launchSpec(agent: string | undefined, task: string | undefined, asyncLaunch?: boolean, context?: string, timeoutMs?: number): SubagentLaunchSpec {
	return {
		agent: required(agent, "agent"),
		task: required(task, "task"),
		async: asyncLaunch,
		context: parseContext(context),
		timeoutMs,
	};
}

function parseAction(value: string | undefined): SubagentAction | undefined {
	if (!value) return undefined;
	const action = value.trim().toLowerCase();
	if ((SUBAGENT_ACTIONS as readonly string[]).includes(action)) return action as SubagentAction;
	throw new Error(`Unknown action "${value}". Use list, get, status, stop, steer, resume, doctor, or omit action to launch.`);
}

function parseContext(value: string | undefined): SubagentContextMode | undefined {
	if (!value) return undefined;
	const context = value.trim().toLowerCase();
	if (context === "fresh") return "fresh";
	if (context === "brief" || context === "fork") return "brief";
	throw new Error(`Unknown context "${value}". Use fresh or brief.`);
}

function required(value: string | undefined, name: string): string {
	const next = value?.trim();
	if (!next) throw new Error(`${name} is required.`);
	return next;
}

function result(content: string, details: ToolDetails): AgentToolResult<ToolDetails> {
	return { content: [{ type: "text", text: content }], details };
}
