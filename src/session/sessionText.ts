import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";

export function sessionEntriesFromMessages(messages: AgentMessage[]): SessionTreeEntry[] {
	const entries: SessionTreeEntry[] = [];
	let parentId: string | null = null;
	for (const message of messages) {
		const id = nextEntryId(entries);
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now()).toISOString(),
			message,
		});
		parentId = id;
	}
	return entries;
}

function nextEntryId(entries: SessionTreeEntry[]): string {
	const used = new Set(entries.map((entry) => entry.id));
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = uuidv7().slice(-8);
		if (!used.has(id)) return id;
	}
	return uuidv7();
}

export function titleFromEntries(entries: SessionTreeEntry[]): string {
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
	const text = typeof user.content === "string"
		? user.content
		: Array.isArray(user.content)
			? user.content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "")).join("")
			: "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? compact.slice(0, 48) : "New chat";
}

export function messageImages(message: AgentMessage): Array<{ type: "image"; data: string; mimeType: string }> {
	if (message.role !== "user" || typeof message.content === "string") return [];
	return message.content.flatMap((part) => (
		part.type === "image" && part.data && part.mimeType
			? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }]
			: []
	));
}

export function messagePlainText(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	}
	if ("summary" in message && typeof message.summary === "string") return message.summary;
	return "";
}

export function createChatId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
