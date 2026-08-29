import { PARENT_RESULT_MAX_BYTES, PARENT_RESULT_MAX_LINES } from "./types";

export type TruncatedText = {
	text: string;
	truncated: boolean;
	originalBytes: number;
	originalLines: number;
};

/** Truncate body first, then always append the footer so run metadata cannot be cut away. */
export function truncateForParent(
	body: string,
	footer: string,
	limits: { maxBytes?: number; maxLines?: number } = {},
): TruncatedText {
	const maxBytes = limits.maxBytes ?? PARENT_RESULT_MAX_BYTES;
	const maxLines = limits.maxLines ?? PARENT_RESULT_MAX_LINES;
	const originalLines = body ? body.split("\n").length : 0;
	const originalBytes = byteLength(body);
	const cut = truncateBody(body, maxBytes, maxLines);
	const notice = cut.truncated
		? `\n\n…[truncated ${originalBytes - byteLength(cut.text)} bytes, ${originalLines - cut.lines} lines omitted; full output is in the subagent inspector]`
		: "";
	const text = `${cut.text}${notice}${footer ? `\n\n${footer}` : ""}`.trim();
	return { text, truncated: cut.truncated, originalBytes, originalLines };
}

export function truncateChars(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function truncateBody(body: string, maxBytes: number, maxLines: number): { text: string; truncated: boolean; lines: number } {
	if (!body) return { text: "", truncated: false, lines: 0 };
	const lines = body.split("\n");
	let text = body;
	let truncated = false;
	if (lines.length > maxLines) {
		text = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	if (byteLength(text) > maxBytes) {
		text = sliceBytes(text, maxBytes);
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline > 0) text = text.slice(0, lastNewline);
		truncated = true;
	}
	return { text, truncated, lines: text ? text.split("\n").length : 0 };
}

function sliceBytes(value: string, maxBytes: number): string {
	if (typeof TextEncoder === "undefined") return value.slice(0, maxBytes);
	const encoded = new TextEncoder().encode(value);
	if (encoded.length <= maxBytes) return value;
	const sliced = encoded.slice(0, maxBytes);
	return new TextDecoder().decode(sliced);
}

function byteLength(value: string): number {
	if (typeof TextEncoder === "undefined") return value.length;
	return new TextEncoder().encode(value).length;
}
