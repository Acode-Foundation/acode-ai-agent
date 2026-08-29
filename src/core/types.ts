import type { AgentMessage, QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Transport } from "@earendil-works/pi-ai";
import type { QuestionnairePrompt } from "../ask/types";
import type { PermissionMode } from "./schema";
import type { SlashCommand } from "./slashCommands";
import type { Task } from "../tasks/types";

/** Built-ins use known IDs; extensions may register any stable provider ID. */
export type ProviderId = string;

export type { PermissionMode };

export type AgentSettings = {
	providerId: ProviderId;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	permissionMode: PermissionMode;
	includeSelection: boolean;
	hideThinkingBlock: boolean;
	autoCompaction: boolean;
	compactionReserveTokens: number;
	compactionKeepRecentTokens: number;
	retryEnabled: boolean;
	retryMaxRetries: number;
	retryBaseDelayMs: number;
	providerTimeoutMs: number;
	providerMaxRetries: number;
	providerMaxRetryDelayMs: number;
	transport: Transport;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	enableSkillCommands: boolean;
	autocompleteMaxVisible: number;
	imageAutoResize: boolean;
	blockImages: boolean;
	globalSkillRoots: string[];
	maxHistoryMessages: number;
	maxWalkFiles: number;
	showTaskTray: boolean;
	activeWorkspaceId: string;
	activeChatId: string;
	customModels: Record<string, string[]>;
};

export type ChatSummary = {
	id: string;
	title: string;
	workspaceId: string;
	workspaceName: string;
	updatedAt: number;
	running: boolean;
};

export type WorkspaceInfo = {
	id: string;
	name: string;
	rootUri: string;
	scheme: string;
	remote: boolean;
};

export type ToolActivity = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	summary?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
};

export type MutationRequest = {
	id: string;
	toolName: string;
	path: string;
	title: string;
	preview: string;
	resolve: (decision: MutationDecision) => void;
};

export type MutationDecision = "allow" | "allow-session" | "deny";

export type QueuedPrompt = {
	text: string;
	mode: "steer" | "followUp";
	images?: number;
};

export type RestoredPrompt = {
	text: string;
	images: ImageContent[];
};

export type SessionTreeItem = {
	id: string;
	parentId: string | null;
	type: string;
	kind: "user" | "assistant" | "tool" | "state" | "summary";
	text: string;
	timestamp: string;
	active: boolean;
	current: boolean;
	label?: string;
};

export type PublicAgentState = {
	status: "booting" | "ready" | "running" | "error";
	messages: AgentMessage[];
	streamingMessage?: AgentMessage;
	activities: ToolActivity[];
	queued: QueuedPrompt[];
	compacting: boolean;
	approval?: MutationRequest;
	questionnaire?: QuestionnairePrompt;
	workspace?: WorkspaceInfo;
	model?: Model<any>;
	models: Model<any>[];
	settings: AgentSettings;
	usage: { tokens: number; cost: number };
	contextTokens: number;
	error?: string;
	chats: ChatSummary[];
	commands: SlashCommand[];
	tasks: Task[];
	activeChatId?: string;
	authFlow?: {
		providerId: ProviderId;
		status: "waiting" | "connected" | "error";
		userCode?: string;
		verificationUri?: string;
		message?: string;
		prompt?: {
			type: "text" | "secret" | "select" | "manual_code";
			message: string;
			placeholder?: string;
			options?: Array<{ id: string; label: string; description?: string }>;
		};
	};
};

export type AgentFeature = {
	id: string;
	label: string;
	description: string;
	available: (context: FeatureContext) => boolean;
};

export type FeatureContext = {
	workspace?: WorkspaceInfo;
	hasProviderCredential: boolean;
};

export type Disposable = { dispose(): void | Promise<void> };
