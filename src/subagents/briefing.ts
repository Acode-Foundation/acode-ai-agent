import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messagePlainText } from "../session/sessionText";
import { truncateChars } from "./truncation";
import { BRIEFING_MAX_CHARS } from "./types";

/** Compact parent handoff. Never copies the full parent transcript into the child. */
export function buildBriefing(messages: AgentMessage[], maxChars = BRIEFING_MAX_CHARS): string {
	const user = lastOfRole(messages, "user");
	const assistant = lastOfRole(messages, "assistant");
	const parts: string[] = [];
	if (user) parts.push(`Last user message:\n${truncateChars(plain(user), Math.floor(maxChars * 0.45))}`);
	if (assistant) parts.push(`Last assistant message:\n${truncateChars(plain(assistant), Math.floor(maxChars * 0.45))}`);
	const text = parts.join("\n\n").trim();
	return text ? truncateChars(text, maxChars) : "";
}

function lastOfRole(messages: AgentMessage[], role: "user" | "assistant"): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === role) return message;
	}
	return undefined;
}

function plain(message: AgentMessage): string {
	return messagePlainText(message).replace(/\s+\n/g, "\n").trim();
}
