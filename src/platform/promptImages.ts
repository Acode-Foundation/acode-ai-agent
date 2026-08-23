import type { ImageContent, Model } from "@earendil-works/pi-ai";
import { fileName, isImagePath } from "../workspace/fileMentions";
import type { AcodeWorkspace } from "../workspace/acodeWorkspace";
import { mentionedFilePaths } from "../ui/composerDraft";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TARGET_EDGE = 2000;

const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/bmp"]);

export function modelAcceptsImages(model?: Model<any>): boolean | undefined {
	if (!model) return false;
	if ((model as Model<any> & { inputModalitiesKnown?: boolean }).inputModalitiesKnown === false) return undefined;
	return model.input.includes("image");
}

export function mimeFromName(name: string, fallback = "image/jpeg"): string {
	const ext = name.split(".").pop()?.toLowerCase();
	if (ext === "png") return "image/png";
	if (ext === "gif") return "image/gif";
	if (ext === "webp") return "image/webp";
	if (ext === "bmp") return "image/bmp";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	return fallback;
}

export function normalizeImageMime(value: string | undefined, name = ""): string | undefined {
	const mime = (value || mimeFromName(name, "")).toLowerCase();
	if (mime === "image/jpg") return "image/jpeg";
	return IMAGE_TYPES.has(mime) ? (mime === "image/jpg" ? "image/jpeg" : mime) : undefined;
}

export async function imageContentFromFile(file: File | Blob, name = "image", autoResize = true): Promise<ImageContent> {
	if (file.size > MAX_IMAGE_BYTES) throw new Error(`${name} is larger than 8MB.`);
	const mime = normalizeImageMime(file.type, name);
	if (!mime) throw new Error(`${name} is not a supported image.`);
	const prepared = autoResize ? await resizeImage(file, mime) : { data: await blobToBase64(file), mimeType: mime };
	return { type: "image", data: prepared.data, mimeType: prepared.mimeType };
}

export async function imageContentFromBytes(bytes: Uint8Array, name: string, mimeType?: string, autoResize = true): Promise<ImageContent> {
	if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${name} is larger than 8MB.`);
	const mime = normalizeImageMime(mimeType, name);
	if (!mime) throw new Error(`${name} is not a supported image.`);
	const blob = new Blob([toArrayBuffer(bytes)], { type: mime });
	return imageContentFromFile(blob, name, autoResize);
}

export async function collectPromptImages(
	text: string,
	attached: ImageContent[],
	workspace?: AcodeWorkspace,
	autoResize = true,
): Promise<ImageContent[]> {
	const images = [...attached];
	if (!workspace) return images;
	const seen = new Set(images.map((image) => image.data.slice(0, 48)));
	for (const path of mentionedFilePaths(text)) {
		if (!isImagePath(path)) continue;
		try {
			const bytes = await workspace.readBinary(path);
			const image = await imageContentFromBytes(bytes, fileName(path), undefined, autoResize);
			if (seen.has(image.data.slice(0, 48))) continue;
			seen.add(image.data.slice(0, 48));
			images.push(image);
		} catch {
			// Mentioned files stay in the prompt text; the model can still read_file.
		}
	}
	return images;
}

export function toPiImages(images: ImageContent[]): ImageContent[] {
	return images
		.filter((image) => image.type === "image" && image.data && image.mimeType)
		.map((image) => ({ type: "image" as const, data: stripDataUrl(image.data), mimeType: normalizeImageMime(image.mimeType) || "image/jpeg" }));
}

function stripDataUrl(data: string): string {
	const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.exec(data);
	return match ? data.slice(match[0].length) : data;
}

async function resizeImage(blob: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
	if (typeof createImageBitmap !== "function" && typeof Image === "undefined") {
		return { data: await blobToBase64(blob), mimeType };
	}
	const bitmap = await decodeImage(blob);
	try {
		const scale = Math.min(1, TARGET_EDGE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		if (scale >= 1) {
			return { data: await blobToBase64(blob), mimeType };
		}
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) return { data: await blobToBase64(blob), mimeType };
		context.drawImage(bitmap, 0, 0, width, height);
		const outputType = mimeType === "image/png" || mimeType === "image/gif" ? mimeType : "image/jpeg";
		const dataUrl = canvas.toDataURL(outputType, 0.82);
		return { data: stripDataUrl(dataUrl), mimeType: outputType };
	} finally {
		bitmap.close?.();
	}
}

async function decodeImage(blob: Blob): Promise<ImageBitmap> {
	if (typeof createImageBitmap === "function") return createImageBitmap(blob);
	const url = URL.createObjectURL(blob);
	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const element = new Image();
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("Could not decode image."));
			element.src = url;
		});
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth || image.width;
		canvas.height = image.naturalHeight || image.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Could not decode image.");
		context.drawImage(image, 0, 0);
		return await createImageBitmap(canvas);
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function blobToBase64(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	return bytesToBase64(new Uint8Array(buffer));
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x2000;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	}
	return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
