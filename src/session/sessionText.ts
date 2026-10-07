import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { TranscriptMessage } from "../core/types";

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

export function messageImages(message: { role: string; content?: unknown }): ImageContent[] {
  if (message.role !== "user" || !Array.isArray(message.content)) return [];
  return (message.content as Exclude<UserMessage["content"], string>).flatMap((part) =>
    part?.type === "image" && part.data && part.mimeType
      ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }]
      : [],
  );
}

export function messagePlainText(
  message: TranscriptMessage | { role: string; content?: unknown },
): string {
  if (message.role === "compactionSummary" && "summary" in message) return String(message.summary);
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("");
}
