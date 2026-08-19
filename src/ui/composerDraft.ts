import type { ImageContent } from "@earendil-works/pi-ai";
import { fileName } from "../workspace/fileMentions";

export type DraftImage = ImageContent & { id: string; name: string; uri?: string };

export type ComposerDraft = {
	text: string;
	images: DraftImage[];
};

export type UserPart =
	| { type: "text"; text: string }
	| { type: "file"; path: string }
	| { type: "image"; mimeType: string; data: string; name?: string; uri?: string }
	| { type: "imageRef"; name: string };

export function imagePlaceholder(name: string): string {
	return `[#image ${name}]`;
}

const TOKEN = /@((?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.[A-Za-z][\w.-]*)|\[#image\s+([^\]]+)\]/g;

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

export function splitUserText(text: string): Array<Extract<UserPart, { type: "text" | "file" | "imageRef" }>> {
	const parts: Array<Extract<UserPart, { type: "text" | "file" | "imageRef" }>> = [];
	const source = text ?? "";
	let cursor = 0;
	TOKEN.lastIndex = 0;
	for (const match of source.matchAll(TOKEN)) {
		const start = match.index ?? 0;
		if (match[1] && isEmailAt(source, start)) continue;
		if (start > cursor) parts.push({ type: "text", text: source.slice(cursor, start) });
		if (match[2]) parts.push({ type: "imageRef", name: match[2] });
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
	const parts: UserPart[] = [];
	let imageIndex = 0;
	for (const part of splitUserText(text)) {
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
	return { text, images };
}

export function fileChipLabel(path: string): string {
	return fileName(path);
}

function isEmailAt(text: string, index: number): boolean {
	const before = text[index - 1];
	return Boolean(before && /[A-Za-z0-9]/.test(before));
}
