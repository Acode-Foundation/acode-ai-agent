import type { ReadImageProcessor } from "@earendil-works/pi-agent-core";
import { bytesToBase64, normalizeImageMime } from "./promptImages";

const TARGET_EDGE = 2000;

type DecodedImage = {
	source: CanvasImageSource;
	width: number;
	height: number;
	close?: () => void;
};

/** Acode's browser-backed implementation of Pi's public ReadImageProcessor API. */
export const browserReadImageProcessor: ReadImageProcessor = async (bytes, suppliedMimeType, options) => {
	const mimeType = normalizeImageMime(suppliedMimeType);
	if (!mimeType) {
		return { ok: false, message: "[Image omitted: unsupported inline image format.]" };
	}

	const mustConvert = mimeType === "image/bmp";
	if (!options.autoResizeImages && !mustConvert) {
		return { ok: true, data: bytesToBase64(bytes), mimeType, hints: [] };
	}
	if (!canTransformImages()) {
		return mustConvert
			? { ok: false, message: "[Image omitted: this device could not convert the BMP to PNG.]" }
			: { ok: true, data: bytesToBase64(bytes), mimeType, hints: [] };
	}

	let decoded: DecodedImage | undefined;
	try {
		decoded = await decodeImage(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
		const scale = options.autoResizeImages
			? Math.min(1, TARGET_EDGE / Math.max(decoded.width, decoded.height))
			: 1;
		if (scale >= 1 && !mustConvert) {
			return { ok: true, data: bytesToBase64(bytes), mimeType, hints: [] };
		}

		const width = Math.max(1, Math.round(decoded.width * scale));
		const height = Math.max(1, Math.round(decoded.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas rendering is unavailable.");
		context.drawImage(decoded.source, 0, 0, width, height);

		const preferredMimeType = outputMimeType(mimeType);
		const encoded = parseDataUrl(canvas.toDataURL(preferredMimeType, 0.82));
		const hints: string[] = [];
		if (encoded.mimeType !== mimeType) {
			hints.push(`[Image converted from ${mimeType} to ${encoded.mimeType}.]`);
		}
		if (width !== decoded.width || height !== decoded.height) {
			const coordinateScale = Math.max(decoded.width / width, decoded.height / height);
			hints.push(
				`[Image: original ${decoded.width}x${decoded.height}, displayed at ${width}x${height}. ` +
				`Multiply coordinates by ${formatScale(coordinateScale)} to map to the original image.]`,
			);
		}
		return { ok: true, data: encoded.data, mimeType: encoded.mimeType, hints };
	} catch {
		return { ok: false, message: "[Image omitted: could not be decoded or resized for inline display.]" };
	} finally {
		decoded?.close?.();
	}
};

function canTransformImages(): boolean {
	return typeof document !== "undefined"
		&& typeof document.createElement === "function"
		&& (typeof createImageBitmap === "function" || typeof Image !== "undefined");
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
	if (typeof createImageBitmap === "function") {
		const bitmap = await createImageBitmap(blob);
		return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
	}

	const url = URL.createObjectURL(blob);
	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const element = new Image();
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("Could not decode image."));
			element.src = url;
		});
		return {
			source: image,
			width: image.naturalWidth || image.width,
			height: image.naturalHeight || image.height,
		};
	} finally {
		URL.revokeObjectURL(url);
	}
}

function outputMimeType(input: string): string {
	if (input === "image/jpeg") return "image/jpeg";
	if (input === "image/webp") return "image/webp";
	return "image/png";
}

function parseDataUrl(value: string): { data: string; mimeType: string } {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(value);
	if (!match) throw new Error("Canvas returned invalid image data.");
	return { mimeType: match[1].toLowerCase(), data: match[2] };
}

function formatScale(value: number): string {
	return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
