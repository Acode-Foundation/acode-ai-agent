import { fileName, isImagePath } from "../workspace/fileMentions";
import type { DraftFile, DraftImage } from "../ui/composerDraft";
import { bytesToBase64, imageContentFromBytes } from "./promptImages";

const MAX_FILE_CHARS = 256 * 1024;
const MAX_BINARY_BYTES = 64 * 1024;

export async function pickAcodeFile(autoResize = true): Promise<DraftFile | DraftImage | undefined> {
	const browser = acode.require("fileBrowser") as FileBrowser | undefined;
	if (typeof browser !== "function") throw new Error("Acode's file picker is unavailable.");
	try {
		const picked = await browser("file", "Choose a file to attach", true);
		if (!picked?.url) return undefined;
		const name = picked.name || fileName(picked.url) || "file";
		const buffer = await acode.fsOperation(picked.url).readFile();
		const bytes = new Uint8Array(buffer);
		if (isImagePath(name)) {
			const image = await imageContentFromBytes(bytes, name, undefined, autoResize);
			return { ...image, id: newId("img"), name, uri: picked.url };
		}
		const source = decodeText(bytes);
		const binary = source === undefined;
		const content = binary
			? bytesToBase64(bytes.subarray(0, MAX_BINARY_BYTES))
			: source.length > MAX_FILE_CHARS ? `${source.slice(0, MAX_FILE_CHARS)}\n\n[Attachment truncated.]` : source;
		return {
			id: newId("file"),
			name,
			uri: picked.url,
			content,
			encoding: binary ? "base64" : "text",
			truncated: binary ? bytes.byteLength > MAX_BINARY_BYTES : source.length > MAX_FILE_CHARS,
		};
	} catch (error) {
		if (isCancel(error)) return undefined;
		throw error;
	}
}

function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.subarray(0, MAX_FILE_CHARS).some((byte) => byte === 0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function isCancel(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /cancel|cancell?ed|abort/i.test(message);
}

function newId(prefix: string): string {
	return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
