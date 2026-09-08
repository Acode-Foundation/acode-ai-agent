import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";

export function titleFromEntries(entries: Entry[]): string {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const title = titleFromMessages([entry.message]);
    if (title !== "New chat") return title;
  }
  return "New chat";
}

export function titleFromMessages(messages: Array<{ role?: string; content?: unknown }>): string {
  const user = messages.find((message) => message.role === "user");
  if (!user) return "New chat";
  const text =
    typeof user.content === "string"
      ? user.content
      : Array.isArray(user.content)
        ? user.content
            .map((part) =>
              part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "",
            )
            .join("")
        : "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 48) : "New chat";
}

export function messageImages(
  message: AgentMessage,
): Array<{ type: "image"; data: string; mimeType: string }> {
  if (message.role !== "user" || typeof message.content === "string") return [];
  return message.content.flatMap((part) =>
    part.type === "image" && part.data && part.mimeType
      ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }]
      : [],
  );
}

export function messagePlainText(message: AgentMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  }
  if ("summary" in message && typeof message.summary === "string") return message.summary;
  return "";
}

export function createChatId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}
