import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Signal } from "../core/events";
import type { AgentSettings } from "../core/types";
import type { MutationGate } from "../permissions/mutationGate";
import type { ProviderRegistry } from "../providers/providerRegistry";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { builtinCatalog, mergeCatalog, resolveAgent } from "./agents";
import { buildBriefing } from "./briefing";
import { launchChild, type ChildHandle } from "./child";
import { discoverProjectAgents, discoverUserAgents } from "./discovery";
import { toolsForAgent } from "./filterTools";
import { formatCatalog, formatDoctor, formatRunList, formatRunLine, runFooter } from "./format";
import { catalogPromptEntries, parentDelegationPrompt } from "./prompt";
import { truncateChars, truncateForParent } from "./truncation";
import {
	DEFAULT_SUBAGENT_MAX_CONCURRENT,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	INSPECT_OUTPUT_MAX_CHARS,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_LAUNCH,
	MAX_RETAINED_SUBAGENT_RUNS,
	MAX_SUBAGENT_SPAWNS_PER_RUN,
	TASK_MAX_CHARS,
	type SubagentCatalogEntry,
	type SubagentDefinition,
	type SubagentInspect,
	type SubagentLaunchSpec,
	type SubagentRunView,
	type SubagentWorkItem,
} from "./types";

type LiveRun = {
	view: SubagentRunView;
	work: SubagentWorkItem[];
	output: string;
	handle?: ChildHandle;
	releaseSlot?: () => void;
	abort: AbortController;
	done: Promise<void>;
};

export type SubagentRuntimeHost = {
	workspace: AcodeWorkspace;
	providers: ProviderRegistry;
	settings: () => AgentSettings;
	mutationGate: MutationGate;
	tools: () => AgentTool[];
	messages: () => AgentMessage[];
	parentPrompt?: () => Promise<string>;
	model: () => Model<any> | undefined;
};

export class SubagentRuntime {
	readonly changes = new Signal<SubagentRunView[]>();
	#host: SubagentRuntimeHost;
	#catalog: SubagentDefinition[] = builtinCatalog();
	#runs = new Map<string, LiveRun>();
	#order: string[] = [];
	#active = 0;
	#waiters: Array<() => void> = [];
	#spawnsThisParentRun = 0;
	#disposed = false;

	constructor(host: SubagentRuntimeHost) {
		this.#host = host;
	}

	views(): SubagentRunView[] {
		return this.#order.flatMap((id) => {
			const view = this.#runs.get(id)?.view;
			return view ? [cloneView(view)] : [];
		});
	}

	inspect(id: string): SubagentInspect {
		const live = this.#requireRun(id);
		return {
			run: cloneView(live.view),
			work: live.work.map((item) => ({ ...item })),
			output: truncateChars(live.output, INSPECT_OUTPUT_MAX_CHARS),
		};
	}

	catalog(): SubagentCatalogEntry[] {
		return catalogPromptEntries(this.#catalog);
	}

	parentPromptBlock(): string {
		return parentDelegationPrompt(this.catalog());
	}

	async reloadCatalog(): Promise<SubagentCatalogEntry[]> {
		const [project, user] = await Promise.all([
			discoverProjectAgents(this.#host.workspace),
			discoverUserAgents(),
		]);
		this.#catalog = mergeCatalog(mergeCatalog(builtinCatalog(), user), project);
		return this.catalog();
	}

	beginParentRun(): void {
		this.#spawnsThisParentRun = 0;
	}

	async launch(spec: SubagentLaunchSpec, options: LaunchOptions = {}): Promise<string> {
		const run = this.#enqueue(spec, options);
		if (run.view.async) {
			return `Started ${run.view.agent} (${run.view.id}) in the background.\nUse subagent({ action: "status", id: "${run.view.id}" }) when you need the result. Do not poll in a loop.`;
		}
		await run.done;
		return parentFacing(run);
	}

	async launchMany(specs: SubagentLaunchSpec[], options: LaunchOptions = {}): Promise<string> {
		if (specs.length > MAX_PARALLEL_LAUNCH) {
			throw new Error(`Launch at most ${MAX_PARALLEL_LAUNCH} parallel subagents at a time.`);
		}
		const background = options.async ?? this.#host.settings().subagentDefaultAsync;
		const runs = specs.map((spec) => this.#enqueue({ ...spec, async: background }, options));
		if (background) {
			return [
				`Started ${runs.length} background subagents.`,
				...runs.map((run) => `${run.view.id}  ${run.view.agent}`),
				"Use status with an id when you need a result. Do not poll in a loop.",
			].join("\n");
		}
		await Promise.all(runs.map((run) => run.done));
		return runs.map((run) => `[${run.view.agent} · ${run.view.id}]\n${parentFacing(run)}`).join("\n\n");
	}

	async launchChain(specs: SubagentLaunchSpec[], options: LaunchOptions = {}): Promise<string> {
		if (specs.length > MAX_CHAIN_STEPS) throw new Error(`Chains are limited to ${MAX_CHAIN_STEPS} steps.`);
		const outputs: string[] = [];
		for (const [index, spec] of specs.entries()) {
			const previous = outputs.at(-1);
			const task = previous
				? `${spec.task}\n\nPrevious step result:\n${truncateChars(stripMeta(previous), 4_000)}`
				: spec.task;
			options.onProgress?.(`Chain ${index + 1}/${specs.length} · ${spec.agent}`);
			const run = this.#enqueue({ ...spec, task, async: false }, options);
			await run.done;
			const text = parentFacing(run);
			outputs.push(text);
			if (run.view.status !== "completed") {
				return `Chain stopped at step ${index + 1} (${spec.agent}).\n${text}`;
			}
		}
		return outputs.map((text, index) => `[step ${index + 1} · ${specs[index]?.agent}]\n${text}`).join("\n\n");
	}

	listAgents(): string {
		return formatCatalog(this.catalog());
	}

	getAgent(name: string): string {
		const agent = resolveAgent(name, this.#catalog);
		const tools = agent.tools === "inherit" ? "inherit parent tools except nested subagents" : agent.tools.join(", ");
		return [
			`${agent.name} (${agent.role}, ${agent.scope})`,
			agent.description,
			agent.aliases.length ? `Aliases: ${agent.aliases.join(", ")}` : undefined,
			`Tools: ${tools}`,
			`Context: ${agent.defaultContext}`,
			agent.sourcePath ? `Source: ${agent.sourcePath}` : undefined,
		].filter(Boolean).join("\n");
	}

	status(id?: string): string {
		if (!id) return formatRunList(this.views());
		const live = this.#requireRun(id);
		if (live.view.status === "running" || live.view.status === "queued") {
			return `${formatRunLine(live.view)}\n\n${live.output.trim() || "(still running)"}`;
		}
		return parentFacing(live);
	}

	async stop(id: string): Promise<string> {
		const live = this.#requireRun(id);
		if (live.view.status !== "queued" && live.view.status !== "running") {
			return `${id} is already ${live.view.status}.`;
		}
		live.abort.abort();
		await live.handle?.stop().catch(() => undefined);
		await live.done.catch(() => undefined);
		return `Stopped ${id}.`;
	}

	async stopAll(): Promise<void> {
		const live = [...this.#runs.values()].filter((run) => run.view.status === "queued" || run.view.status === "running");
		for (const run of live) run.abort.abort();
		await Promise.all(live.map((run) => run.handle?.stop().catch(() => undefined)));
		this.#waiters.splice(0).forEach((wake) => wake());
		await Promise.all(live.map((run) => run.done.catch(() => undefined)));
	}

	async steer(id: string, message: string): Promise<string> {
		const live = this.#requireRun(id);
		if (live.view.status !== "running" || !live.handle) throw new Error(`${id} is not running.`);
		await live.handle.steer(message);
		return `Steered ${id}. Delivery means the child accepted the text, not that it complied.`;
	}

	async resume(id: string, message: string, options: LaunchOptions = {}): Promise<string> {
		const live = this.#requireRun(id);
		if (live.view.status === "running" || live.view.status === "queued") {
			throw new Error(`${id} is still ${live.view.status}. Use steer for a live child.`);
		}
		if (!live.view.resumable) throw new Error(`${id} cannot be resumed. Start a new run.`);
		const followUp = message.trim();
		if (!followUp) throw new Error("Resume requires a message.");
		const run = this.#enqueue({
			agent: live.view.agent,
			task: followUp,
			async: false,
			context: "brief",
		}, {
			...options,
			resumedFrom: id,
			briefing: [
				live.output.trim() ? `Previous result:\n${truncateChars(live.output.trim(), 4_000)}` : undefined,
				buildBriefing(this.#host.messages()),
			].filter(Boolean).join("\n\n"),
		});
		await run.done;
		return parentFacing(run);
	}

	doctor(): string {
		const settings = this.#host.settings();
		const tools = this.#host.tools().map((tool) => tool.name);
		return formatDoctor({
			agents: this.#catalog.map((agent) => agent.name),
			maxConcurrent: settings.subagentMaxConcurrent,
			timeoutMs: settings.subagentTimeoutMs,
			defaultAsync: settings.subagentDefaultAsync,
			bash: tools.includes("bash"),
			permissionMode: settings.permissionMode,
			active: [...this.#runs.values()].filter((run) => run.view.status === "running").length,
			queued: [...this.#runs.values()].filter((run) => run.view.status === "queued").length,
		});
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		await this.stopAll();
		this.changes.clear();
		this.#runs.clear();
		this.#order = [];
	}

	#enqueue(spec: SubagentLaunchSpec, options: LaunchOptions): LiveRun {
		if (this.#disposed) throw new Error("Subagent runtime is disposed.");
		const task = spec.task.trim();
		if (!task) throw new Error("A subagent task is required.");
		if (task.length > TASK_MAX_CHARS) throw new Error(`Task is limited to ${TASK_MAX_CHARS} characters.`);
		this.#spawnsThisParentRun += 1;
		if (this.#spawnsThisParentRun > MAX_SUBAGENT_SPAWNS_PER_RUN) {
			throw new Error(`This parent run already started ${MAX_SUBAGENT_SPAWNS_PER_RUN} subagents.`);
		}
		this.#prune();
		const agent = resolveAgent(spec.agent, this.#catalog);
		const settings = this.#host.settings();
		const model = this.#host.model();
		if (!model) throw new Error("The parent session is not ready to launch a subagent.");
		const tools = toolsForAgent(agent, this.#host.tools());
		if (!tools.length) throw new Error(`${agent.name} has no available tools in this workspace.`);
		const id = createRunId();
		const context = spec.context ?? agent.defaultContext;
		const briefing = options.briefing ?? (context === "brief" ? buildBriefing(this.#host.messages()) : undefined);
		const timeoutMs = clampTimeout(spec.timeoutMs ?? settings.subagentTimeoutMs);
		const background = spec.async ?? options.async ?? settings.subagentDefaultAsync;
		const view: SubagentRunView = {
			id,
			agent: agent.name,
			task,
			status: "queued",
			async: Boolean(background),
			startedAt: Date.now(),
			toolCount: 0,
			resumable: false,
			resumedFrom: options.resumedFrom,
			modelId: model.id,
		};
		const abort = new AbortController();
		const onParentAbort = () => abort.abort();
		options.signal?.addEventListener("abort", onParentAbort, { once: true });
		if (options.signal?.aborted) abort.abort();
		const live: LiveRun = { view, work: [], output: "", abort, done: Promise.resolve() };
		this.#runs.set(id, live);
		this.#order.push(id);
		this.#publish();
		options.onProgress?.(`${agent.name} queued`);
		live.done = this.#run(live, {
			agent,
			task,
			briefing,
			tools,
			model,
			settings,
			timeoutMs,
			onProgress: options.onProgress,
		}).finally(() => {
			options.signal?.removeEventListener("abort", onParentAbort);
		});
		return live;
	}

	async #run(live: LiveRun, started: {
		agent: SubagentDefinition;
		task: string;
		briefing?: string;
		tools: AgentTool[];
		model: Model<any>;
		settings: AgentSettings;
		timeoutMs: number;
		onProgress?: (text: string) => void;
	}): Promise<void> {
		let release: (() => void) | undefined;
		try {
			release = await this.#acquire(started.settings.subagentMaxConcurrent, live.abort.signal);
			live.releaseSlot = release;
			if (live.abort.signal.aborted) {
				this.#settle(live, { status: "stopped", error: "Subagent was stopped before it started.", resumable: false });
				return;
			}
			live.view.status = "running";
			this.#publish();
			const parentPrompt = started.agent.systemPromptMode === "append" ? await this.#host.parentPrompt?.() : undefined;
			const handle = launchChild({
				id: live.view.id,
				agent: started.agent,
				task: started.task,
				briefing: started.briefing,
				parentPrompt,
				tools: started.tools,
				models: this.#host.providers.models,
				model: started.model,
				settings: started.settings,
				workspace: this.#host.workspace,
				mutationGate: this.#host.mutationGate,
				timeoutMs: started.timeoutMs,
				signal: live.abort.signal,
				onProgress: (progress) => {
					live.work = progress.work;
					live.output = progress.output;
					live.view.lastTool = progress.lastTool;
					live.view.toolCount = progress.toolCount;
					this.#publish();
					if (progress.lastTool) started.onProgress?.(`${started.agent.name} · ${progress.lastTool}`);
				},
			});
			live.handle = handle;
			const result = await handle.result;
			live.output = result.output;
			live.work = result.work;
			this.#settle(live, {
				status: result.status,
				error: result.error,
				modelId: result.modelId,
				toolCount: result.toolCount,
				resumable: result.status === "completed" || result.status === "failed" || result.status === "timed_out",
			});
		} catch (error) {
			if (live.abort.signal.aborted || isAbortError(error)) {
				this.#settle(live, { status: "stopped", error: "Subagent was stopped.", resumable: false });
				return;
			}
			this.#settle(live, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				resumable: false,
			});
		} finally {
			live.handle = undefined;
			release?.();
			live.releaseSlot = undefined;
		}
	}

	#settle(live: LiveRun, patch: Partial<SubagentRunView>): void {
		if (isTerminal(live.view.status) && live.view.status !== "queued") return;
		live.view = {
			...live.view,
			...patch,
			endedAt: Date.now(),
		};
		const facing = truncateForParent(live.output.trim() || live.view.error || "", runFooter(live.view));
		live.view.output = facing.text;
		live.view.truncated = facing.truncated;
		this.#publish();
	}

	#acquire(max: number, signal?: AbortSignal): Promise<() => void> {
		const cap = Math.max(1, Math.min(4, max || DEFAULT_SUBAGENT_MAX_CONCURRENT));
		if (this.#active < cap) {
			this.#active += 1;
			return Promise.resolve(() => this.#release());
		}
		return new Promise((resolve, reject) => {
			const wake = () => {
				signal?.removeEventListener("abort", onAbort);
				if (this.#active < cap) {
					this.#active += 1;
					resolve(() => this.#release());
					return;
				}
				this.#waiters.push(wake);
			};
			const onAbort = () => {
				this.#waiters = this.#waiters.filter((item) => item !== wake);
				reject(new DOMException("Operation aborted", "AbortError"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.#waiters.push(wake);
		});
	}

	#release(): void {
		this.#active = Math.max(0, this.#active - 1);
		const next = this.#waiters.shift();
		next?.();
	}

	#prune(): void {
		while (this.#order.length >= MAX_RETAINED_SUBAGENT_RUNS) {
			const id = this.#order.find((item) => {
				const status = this.#runs.get(item)?.view.status;
				return status !== "running" && status !== "queued";
			});
			if (!id) break;
			this.#runs.delete(id);
			this.#order = this.#order.filter((item) => item !== id);
		}
	}

	#requireRun(id: string): LiveRun {
		const exact = this.#runs.get(id);
		if (exact) return exact;
		const matches = [...this.#runs.values()].filter((run) => run.view.id.startsWith(id));
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Run id "${id}" is ambiguous.`);
		throw new Error(`Unknown subagent run "${id}".`);
	}

	#publish(): void {
		this.changes.emit(this.views());
	}
}

type LaunchOptions = {
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
	async?: boolean;
	resumedFrom?: string;
	briefing?: string;
};

function parentFacing(live: LiveRun): string {
	if (live.view.output) return live.view.output;
	const truncated = truncateForParent(live.output.trim() || live.view.error || "(no output)", runFooter(live.view));
	return truncated.text;
}

function cloneView(view: SubagentRunView): SubagentRunView {
	return { ...view };
}

function createRunId(): string {
	const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	return `sa_${raw.replace(/-/g, "").slice(0, 10)}`;
}

function clampTimeout(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SUBAGENT_TIMEOUT_MS;
	return Math.min(1_200_000, Math.max(30_000, Math.round(value)));
}

function stripMeta(text: string): string {
	return text.replace(/\n*<subagent-meta>[\s\S]*<\/subagent-meta>\s*$/, "").trim();
}

function isTerminal(status: SubagentRunView["status"]): boolean {
	return status === "completed" || status === "failed" || status === "stopped" || status === "timed_out";
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
