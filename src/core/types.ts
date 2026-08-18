import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { PermissionMode } from "./schema";

/** Built-ins use known IDs; extensions may register any stable provider ID. */
export type ProviderId = string;

export type { PermissionMode };

export type AgentSettings = {
	providerId: ProviderId;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	permissionMode: PermissionMode;
	includeSelection: boolean;
	maxHistoryMessages: number;
	maxWalkFiles: number;
	activeWorkspaceId: string;
	activeChatId: string;
	customModels: Record<string, string[]>;
};

export type ChatSummary = {
	id: string;
	title: string;
	workspaceId: string;
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
};

export type PublicAgentState = {
	status: "booting" | "ready" | "running" | "error";
	messages: AgentMessage[];
	streamingMessage?: AgentMessage;
	activities: ToolActivity[];
	queued: QueuedPrompt[];
	compacting: boolean;
	approval?: MutationRequest;
	workspace?: WorkspaceInfo;
	model?: Model<any>;
	models: Model<any>[];
	settings: AgentSettings;
	usage: { tokens: number; cost: number };
	contextTokens: number;
	error?: string;
	chats: ChatSummary[];
	activeChatId?: string;
	authFlow?: {
		providerId: ProviderId;
		status: "waiting" | "connected" | "error";
		userCode?: string;
		verificationUri?: string;
		message?: string;
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
