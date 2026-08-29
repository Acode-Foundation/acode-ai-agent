import type { ImageContent } from "@earendil-works/pi-ai";
import { fileName } from "../workspace/fileMentions";

export type DraftImage = ImageContent & { id: string; name: string; uri?: string };

export type DraftFile = {
	id: string;
	name: string;
	uri?: string;
	content: string;
	encoding: "text" | "base64";
	kind?: "paste";
	pasteId?: number;
	truncated?: boolean;
};

export type ComposerDraft = {
	text: string;
	images: DraftImage[];
	files: DraftFile[];
};

export type UserPart =
	| { type: "text"; text: string }
	| { type: "file"; path: string }
	| { type: "attachment"; name: string; content?: string; encoding?: "text" | "base64"; kind?: "paste"; truncated?: boolean }
	| { type: "paste"; id: number; label: string }
	| { type: "image"; mimeType: string; data: string; name?: string; uri?: string }
	| { type: "imageRef"; name: string };

/** Pi TUI: collapse a paste when it is more than 10 lines or more than 1000 characters. */
export const LARGE_PASTE_LINE_LIMIT = 10;
export const LARGE_PASTE_CHAR_LIMIT = 1000;

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
export const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

export function imagePlaceholder(name: string): string {
	return `[#image ${name}]`;
}

export function filePlaceholder(name: string): string {
	return `[#file ${name.replace(/\]/g, "") || "file"}]`;
}

const TOKEN = /@((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.[A-Za-z][\w.-]*)|\[#image\s+([^\]]+)\]|\[#file\s+([^\]]+)\]|\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const ATTACHMENTS = /\n*<attached_files>\n[\s\S]*?\n<\/attached_files>\s*$/;

export function mentionedFilePaths(text: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const part of splitUserText(text)) {
		if (part.type !== "file" || seen.has(part.path)) continue;
		seen.add(part.path);
		paths.push(part.path);
	}
	return paths;
}

export function splitUserText(text: string): Array<Extract<UserPart, { type: "text" | "file" | "attachment" | "imageRef" | "paste" }>> {
	const parts: Array<Extract<UserPart, { type: "text" | "file" | "attachment" | "imageRef" | "paste" }>> = [];
	const source = stripAttachedFiles(text ?? "");
	let cursor = 0;
	TOKEN.lastIndex = 0;
	for (const match of source.matchAll(TOKEN)) {
		const start = match.index ?? 0;
		if (match[1] && isEmailAt(source, start)) continue;
		if (start > cursor) parts.push({ type: "text", text: source.slice(cursor, start) });
		if (match[2]) parts.push({ type: "imageRef", name: match[2] });
		else if (match[3]) parts.push({ type: "attachment", name: match[3] });
		else if (match[4]) parts.push({ type: "paste", id: Number(match[4]), label: match[0] });
		else parts.push({ type: "file", path: match[1]! });
		cursor = start + match[0].length;
	}
	if (cursor < source.length) parts.push({ type: "text", text: source.slice(cursor) });
	return parts.filter((part) => part.type !== "text" || part.text.length > 0);
}

export function userPartsFromMessage(content: string | Array<{ type?: string; text?: string; data?: string; mimeType?: string }>): UserPart[] {
	const text = typeof content === "string"
		? content
		: content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
	const images = typeof content === "string"
		? []
		: content.flatMap((block) => (
			block.type === "image" && block.data && block.mimeType
				? [{ type: "image" as const, data: block.data, mimeType: block.mimeType, name: undefined as string | undefined }]
				: []
		));
	const files = attachedFilesFromPrompt(typeof content === "string" ? content : text);
	const pastes = files.filter((file) => file.kind === "paste");
	const attachments = files.filter((file) => file.kind !== "paste");
	const parts: UserPart[] = [];
	let imageIndex = 0;
	let fileIndex = 0;
	for (const part of splitUserText(text)) {
		if (part.type === "attachment") {
			const file = attachments[fileIndex++];
			parts.push({
				type: "attachment",
				name: part.name,
				content: file?.content,
				encoding: file?.encoding,
				kind: file?.kind,
				truncated: file?.truncated,
			});
			continue;
		}
		if (part.type === "paste") {
			const file = pastes.find((item) => item.pasteId === part.id);
			parts.push({
				type: "attachment",
				name: file ? pasteChipLabel(part.id, file.content) : part.label.replace(/^\[|\]$/g, ""),
				content: file?.content,
				encoding: file?.encoding ?? "text",
				kind: "paste",
				truncated: file?.truncated,
			});
			continue;
		}
		if (part.type !== "imageRef") {
			parts.push(part);
			continue;
		}
		const image = images[imageIndex++];
		parts.push(image
			? { type: "image", data: image.data, mimeType: image.mimeType, name: part.name }
			: { type: "imageRef", name: part.name });
	}
	while (imageIndex < images.length) {
		const image = images[imageIndex++]!;
		parts.push({ type: "image", data: image.data, mimeType: image.mimeType, name: image.name });
	}
	return parts;
}

export function imageSrc(image: { data: string; mimeType: string }): string {
	return image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`;
}

export function draftFromParts(text: string, images: DraftImage[] = []): ComposerDraft {
	return { text: stripAttachedFiles(text), images, files: attachedFilesFromPrompt(text) };
}

export function promptTextFromDraft(draft: ComposerDraft): string {
	const text = stripAttachedFiles(draft.text).trim();
	if (!draft.files.length) return text;
	const packed = JSON.stringify(draft.files.map(({ name, content, encoding, truncated, kind, pasteId }) => ({
		name,
		content,
		encoding,
		truncated,
		kind,
		pasteId,
	})));
	return `${text}\n\n<attached_files>\n${packed}\n</attached_files>`;
}

export function normalizePastedText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.split("")
		.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
		.join("");
}

export function isLargePaste(text: string): boolean {
	if (!text) return false;
	return text.split("\n").length > LARGE_PASTE_LINE_LIMIT || text.length > LARGE_PASTE_CHAR_LIMIT;
}

export function pasteMarker(id: number, content: string): string {
	const lines = content.split("\n").length;
	return lines > LARGE_PASTE_LINE_LIMIT
		? `[paste #${id} +${lines} lines]`
		: `[paste #${id} ${content.length} chars]`;
}

export function pasteChipLabel(id: number, content: string): string {
	return pasteMarker(id, content).slice(1, -1);
}

export function nextPasteId(files: DraftFile[]): number {
	let max = 0;
	for (const file of files) {
		if (file.kind !== "paste") continue;
		if (typeof file.pasteId === "number" && file.pasteId > max) max = file.pasteId;
	}
	return max + 1;
}

export function draftFileFromPaste(content: string, files: DraftFile[]): DraftFile {
	const pasteId = nextPasteId(files);
	return {
		id: `paste-${pasteId}`,
		name: pasteChipLabel(pasteId, content),
		content,
		encoding: "text",
		kind: "paste",
		pasteId,
	};
}

export function expandPasteMarkers(text: string, files: DraftFile[]): string {
	let result = text;
	for (const file of files) {
		if (file.kind !== "paste" || typeof file.pasteId !== "number") continue;
		const marker = new RegExp(`\\[paste #${file.pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
		result = result.replace(marker, () => file.content);
	}
	return result;
}

function attachedFilesFromPrompt(text: string): DraftFile[] {
	const body = /<attached_files>\n([\s\S]*?)\n<\/attached_files>/.exec(text)?.[1];
	if (!body) return [];
	try {
		const files = JSON.parse(body) as Array<Omit<DraftFile, "id" | "uri">>;
		return files.map((file, index) => ({ ...file, id: `restored-${index}` }));
	} catch {
		return [];
	}
}

function stripAttachedFiles(text: string): string {
	return text.replace(ATTACHMENTS, "").replace(/\n+$/, "");
}

export function fileChipLabel(path: string): string {
	return fileName(path);
}

function isEmailAt(text: string, index: number): boolean {
	const before = text[index - 1];
	return Boolean(before && /[A-Za-z0-9]/.test(before));
}
