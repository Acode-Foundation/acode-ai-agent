import { DEFAULT_COMPACTION_SETTINGS, type QueueMode, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import { z } from "zod";

export const permissionModeSchema = z.enum(["ask", "allow-edits", "full-access"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const QUEUE_MODES = ["all", "one-at-a-time"] as const satisfies readonly QueueMode[];
const TRANSPORTS = ["sse", "websocket", "websocket-cached", "auto"] as const satisfies readonly Transport[];

export const thinkingLevelSchema = z.enum(THINKING_LEVELS);

export const customModelsSchema = z.record(z.string(), z.array(z.string().min(1).max(120))).catch({});

export const settingsSchema = z.object({
	providerId: z.string().min(1).catch("openrouter"),
	modelId: z.string().min(1).catch("qwen/qwen3.7-flash"),
	thinkingLevel: thinkingLevelSchema.catch("medium"),
	permissionMode: permissionModeSchema.catch("ask"),
	includeSelection: z.boolean().catch(true),
	hideThinkingBlock: z.boolean().catch(false),
	autoCompaction: z.boolean().catch(DEFAULT_COMPACTION_SETTINGS.enabled),
	compactionReserveTokens: z.number().int().min(1_024).max(262_144).catch(DEFAULT_COMPACTION_SETTINGS.reserveTokens),
	compactionKeepRecentTokens: z.number().int().min(1_024).max(262_144).catch(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
	retryEnabled: z.boolean().catch(true),
	retryMaxRetries: z.number().int().min(0).max(10).catch(3),
	retryBaseDelayMs: z.number().int().min(100).max(60_000).catch(2_000),
	providerTimeoutMs: z.number().int().min(0).max(3_600_000).catch(300_000),
	providerMaxRetries: z.number().int().min(0).max(10).catch(0),
	providerMaxRetryDelayMs: z.number().int().min(0).max(3_600_000).catch(60_000),
	transport: z.enum(TRANSPORTS).catch("auto"),
	steeringMode: z.enum(QUEUE_MODES).catch("one-at-a-time"),
	followUpMode: z.enum(QUEUE_MODES).catch("one-at-a-time"),
	enableSkillCommands: z.boolean().catch(true),
	autocompleteMaxVisible: z.number().int().min(7).max(20).catch(10),
	imageAutoResize: z.boolean().catch(true),
	blockImages: z.boolean().catch(false),
	globalSkillRoots: z.array(z.string().min(1).max(1_024)).max(20).catch([]),
	maxHistoryMessages: z.number().int().min(20).max(200).catch(80),
	maxWalkFiles: z.number().int().min(25).max(1000).catch(200),
	activeWorkspaceId: z.string().catch(""),
	activeChatId: z.string().catch(""),
	customModels: customModelsSchema,
}).passthrough();

export const chatMetaSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1).catch("New chat"),
	workspaceId: z.string(),
	workspaceName: z.string().catch(""),
	updatedAt: z.number().int().nonnegative(),
});

export const chatIndexSchema = z.object({
	chats: z.array(chatMetaSchema),
});

export const storedChatSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	workspaceId: z.string(),
	workspaceName: z.string().catch(""),
	providerId: z.string(),
	modelId: z.string(),
	messages: z.array(z.unknown()),
	updatedAt: z.number().int().nonnegative(),
});

export const storedSessionSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	workspaceId: z.string(),
	workspaceName: z.string().catch(""),
	providerId: z.string(),
	modelId: z.string(),
	createdAt: z.string().min(1).catch(""),
	updatedAt: z.number().int().nonnegative(),
	leafId: z.string().nullable().catch(null),
	entries: z.array(z.unknown()).catch([]),
});

export function parseSettings(value: unknown) {
	return settingsSchema.parse(value);
}

export function parseChatIndex(value: unknown) {
	const parsed = z.object({ chats: z.array(z.unknown()) }).safeParse(value);
	if (!parsed.success) return [];
	return parsed.data.chats.flatMap((item) => {
		const chat = chatMetaSchema.safeParse(item);
		return chat.success ? [chat.data] : [];
	});
}

export function parseStoredChat(value: unknown) {
	const parsed = storedChatSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

export function parseStoredSession(value: unknown) {
	const parsed = storedSessionSchema.safeParse(value);
	if (!parsed.success) return undefined;
	return {
		...parsed.data,
		createdAt: parsed.data.createdAt || new Date(parsed.data.updatedAt).toISOString(),
		entries: parsed.data.entries.filter((entry) => {
			return Boolean(entry && typeof entry === "object" && "type" in entry && "id" in entry);
		}),
	};
}

export const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
	{ id: "ask", label: "Ask", hint: "Approve each edit" },
	{ id: "allow-edits", label: "Allow edits", hint: "Edits this session" },
	{ id: "full-access", label: "Full access", hint: "All workspace tools" },
];
