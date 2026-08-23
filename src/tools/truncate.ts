export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-agent-core";

import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-agent-core";

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
