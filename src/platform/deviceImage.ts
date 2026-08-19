import { fileName } from "../workspace/fileMentions";
import { imageContentFromBytes, mimeFromName } from "./promptImages";
import type { DraftImage } from "../ui/composerDraft";

type DocumentPick = {
	uri: string;
	filename?: string;
	name?: string;
	type?: string;
	url?: string;
};

function sdcard(): SDcard | undefined {
	try {
		const native = (globalThis as { sdcard?: SDcard }).sdcard;
		return native && typeof native.openDocumentFile === "function" ? native : undefined;
	} catch {
		return undefined;
	}
}

export async function pickDeviceImage(): Promise<DraftImage | undefined> {
	const picked = await pickWithSDcard();
	if (!picked) return undefined;
	const bytes = await readPickedBytes(picked.uri);
	const image = await imageContentFromBytes(bytes, picked.name, picked.mime);
	return { ...image, id: newId(), name: picked.name, uri: picked.uri };
}

export async function previewImageInAcode(image: {
	name: string;
	data: string;
	mimeType: string;
	uri?: string;
}): Promise<void> {
	if (image.uri) {
		await openAcodeUri(image.uri, image.name);
		return;
	}
	const uri = await writeCacheImage(image);
	await openAcodeUri(uri, image.name);
}

export async function openAcodeUri(uri: string, name = fileNameFromUri(uri)): Promise<void> {
	const existing = editorManager.getFile(uri, "uri");
	if (existing) {
		existing.makeActive();
		return;
	}
	const fileBrowser = acode.require("fileBrowser") as FileBrowser | undefined;
	if (typeof fileBrowser?.openFile === "function") {
		fileBrowser.openFile({ type: "file", url: uri, name });
		return;
	}
	acode.newEditorFile(name, { uri, render: true });
}

function pickWithSDcard(): Promise<{ uri: string; name: string; mime?: string } | undefined> {
	const api = sdcard();
	if (!api) return Promise.reject(new Error("Acode sdcard is not available."));
	return new Promise((resolve, reject) => {
		const ok = (value: string | DocumentPick) => {
			const picked = normalizePick(value);
			if (!picked) {
				reject(new Error("No image was selected."));
				return;
			}
			resolve(picked);
		};
		const fail = (error: unknown) => {
			if (isCancel(error)) {
				resolve(undefined);
				return;
			}
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		api.openDocumentFile(ok, fail, "image/*");
	});
}

function normalizePick(value: string | DocumentPick): { uri: string; name: string; mime?: string } | undefined {
	if (typeof value === "string") {
		if (!value) return undefined;
		return { uri: value, name: fileNameFromUri(value), mime: mimeFromName(fileNameFromUri(value), "") || undefined };
	}
	const uri = value.uri || value.url || "";
	if (!uri) return undefined;
	const name = value.filename || value.name || fileNameFromUri(uri);
	return { uri, name, mime: value.type || mimeFromName(name, "") || undefined };
}

async function writeCacheImage(image: { name: string; data: string; mimeType: string }): Promise<string> {
	const cache = (globalThis as { CACHE_STORAGE?: string }).CACHE_STORAGE;
	if (!cache) throw new Error("Acode cache storage is not available.");
	const safe = (image.name || "image.png").replace(/[^\w.-]+/g, "_");
	const uri = acode.joinUrl(cache, safe);
	const bytes = base64ToBytes(image.data);
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const target = acode.fsOperation(uri);
	if (await target.exists()) await target.writeFile(buffer);
	else await acode.fsOperation(cache).createFile(safe, "");
	if (await acode.fsOperation(uri).exists()) await acode.fsOperation(uri).writeFile(buffer);
	return uri;
}

function base64ToBytes(data: string): Uint8Array {
	const raw = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
	const binary = atob(raw);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

async function readPickedBytes(uri: string): Promise<Uint8Array> {
	const buffer = await acode.fsOperation(uri).readFile();
	return new Uint8Array(buffer);
}

function fileNameFromUri(uri: string): string {
	try {
		const decoded = decodeURIComponent(uri.split("/").pop() || uri);
		return decoded.split("?")[0] || "image";
	} catch {
		return fileName(uri) || "image";
	}
}

function isCancel(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /cancel|cancell?ed|abort/i.test(message);
}

function newId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
