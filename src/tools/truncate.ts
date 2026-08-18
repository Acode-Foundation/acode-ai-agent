export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export type TruncationResult = {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	outputLines: number;
	firstLineExceedsLimit: boolean;
};

const encoder = new TextEncoder();

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
	const lines = content.length === 0 ? [] : content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const totalLines = lines.length;
	const totalBytes = byteLength(content);
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, firstLineExceedsLimit: false };
	}
	if (lines.length && byteLength(lines[0]!) > maxBytes) {
		return { content: "", truncated: true, truncatedBy: "bytes", totalLines, outputLines: 0, firstLineExceedsLimit: true };
	}

	const kept: string[] = [];
	let used = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < maxLines; i += 1) {
		const next = byteLength(lines[i]!) + (i > 0 ? 1 : 0);
		if (used + next > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(lines[i]!);
		used += next;
	}
	return {
		content: kept.join("\n"),
		truncated: true,
		truncatedBy,
		totalLines,
		outputLines: kept.length,
		firstLineExceedsLimit: false,
	};
}

export function selectReadOutput(text: string, offset?: number, limit?: number): { text: string; truncated: boolean } {
	const allLines = text.split("\n");
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}

	let selected = allLines.slice(startLine).join("\n");
	let userLimited: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selected = allLines.slice(startLine, endLine).join("\n");
		userLimited = endLine - startLine;
	}

	const truncation = truncateHead(selected);
	const startDisplay = startLine + 1;
	const total = allLines.length;
	if (truncation.firstLineExceedsLimit) {
		return { text: `[Line ${startDisplay} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit.]`, truncated: true };
	}
	if (truncation.truncated) {
		const endDisplay = startDisplay + truncation.outputLines - 1;
		const reason = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		return {
			text: `[Showing lines ${startDisplay}-${endDisplay} of ${total}${reason}. Use offset=${endDisplay + 1} to continue.]\n\n${truncation.content}`,
			truncated: true,
		};
	}
	if (userLimited !== undefined && startLine + userLimited < total) {
		const remaining = total - (startLine + userLimited);
		return {
			text: `[${remaining} more lines in file. Use offset=${startLine + userLimited + 1} to continue.]\n\n${truncation.content}`,
			truncated: true,
		};
	}
	return { text: truncation.content, truncated: false };
}

function byteLength(text: string): number {
	return encoder.encode(text).length;
}
