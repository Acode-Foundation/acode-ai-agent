import type { ModelThinkingLevel, Transport } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_POLICY, type QueueMode } from "@earendil-works/pi-durable";

const PERMISSION_MODE_IDS = ["ask", "allow-edits", "full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODE_IDS)[number];

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
const QUEUE_MODES = ["all", "one-at-a-time"] as const satisfies readonly QueueMode[];
const TRANSPORTS = [
  "sse",
  "websocket",
  "websocket-cached",
  "auto",
] as const satisfies readonly Transport[];

/** Each field parses its stored value or falls back to its default; unknown keys are kept. */
type Field<T> = (value: unknown) => T;

const text =
  (fallback: string): Field<string> =>
  (value) =>
    typeof value === "string" && value.length > 0 ? value : fallback;
const anyText =
  (fallback: string): Field<string> =>
  (value) =>
    typeof value === "string" ? value : fallback;
const flag =
  (fallback: boolean): Field<boolean> =>
  (value) =>
    typeof value === "boolean" ? value : fallback;
const int =
  (min: number, max: number, fallback: number): Field<number> =>
  (value) =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max
      ? (value as number)
      : fallback;
const oneOf =
  <const T extends readonly string[]>(values: T, fallback: T[number]): Field<T[number]> =>
  (value) =>
    values.includes(value as string) ? (value as T[number]) : fallback;

function isTextList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= maxLength)
  );
}

const customModels: Field<Record<string, string[]>> = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((ids) => isTextList(ids, Number.MAX_SAFE_INTEGER, 120))
    ? (value as Record<string, string[]>)
    : {};

const settingsFields = {
  providerId: text("openrouter"),
  modelId: text("qwen/qwen3.7-flash"),
  thinkingLevel: oneOf(THINKING_LEVELS, "medium"),
  permissionMode: oneOf(PERMISSION_MODE_IDS, "ask"),
  includeSelection: flag(true),
  hideThinkingBlock: flag(false),
  autoCompaction: flag(DEFAULT_COMPACTION_POLICY.enabled),
  compactionReserveTokens: int(1_024, 262_144, DEFAULT_COMPACTION_POLICY.reserveTokens),
  compactionKeepRecentTokens: int(1_024, 262_144, DEFAULT_COMPACTION_POLICY.keepRecentTokens),
  retryEnabled: flag(true),
  retryMaxRetries: int(0, 10, 3),
  retryBaseDelayMs: int(100, 60_000, 2_000),
  providerTimeoutMs: int(0, 3_600_000, 300_000),
  providerMaxRetries: int(0, 10, 0),
  providerMaxRetryDelayMs: int(0, 3_600_000, 60_000),
  transport: oneOf(TRANSPORTS, "auto"),
  steeringMode: oneOf(QUEUE_MODES, "one-at-a-time"),
  followUpMode: oneOf(QUEUE_MODES, "one-at-a-time"),
  enableSkillCommands: flag(true),
  autocompleteMaxVisible: int(7, 20, 10),
  imageAutoResize: flag(true),
  blockImages: flag(false),
  globalSkillRoots: ((value) => (isTextList(value, 20, 1_024) ? value : [])) as Field<string[]>,
  maxHistoryMessages: int(20, 200, 80),
  maxWalkFiles: int(25, 1000, 200),
  showTaskTray: flag(true),
  activeWorkspaceId: anyText(""),
  activeChatId: anyText(""),
  customModels,
  customEndpoints: ((value) => (Array.isArray(value) && value.length <= 20 ? value : [])) as Field<
    unknown[]
  >,
};

type ParsedSettings = {
  [K in keyof typeof settingsFields]: ReturnType<(typeof settingsFields)[K]>;
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODE_IDS.includes(value as PermissionMode);
}

export function parseSettings(value: unknown): ParsedSettings & Record<string, unknown> {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const parsed: Record<string, unknown> = { ...input };
  for (const [key, field] of Object.entries(settingsFields)) parsed[key] = field(input[key]);
  return parsed as ParsedSettings & Record<string, unknown>;
}

export const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "ask", label: "Ask", hint: "Approve each edit" },
  { id: "allow-edits", label: "Allow edits", hint: "Edits this session" },
  { id: "full-access", label: "Full access", hint: "All workspace tools" },
];
