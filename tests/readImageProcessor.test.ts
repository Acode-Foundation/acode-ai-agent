import { afterEach, expect, test, vi } from "vitest";
import { browserReadImageProcessor } from "../src/platform/readImageProcessor.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

test("passes PNG bytes through when browser image transforms are unavailable", async () => {
	const bytes = new Uint8Array([1, 2, 3, 4]);

	const output = await browserReadImageProcessor(bytes, "image/png", { autoResizeImages: true });

	expect(output).toEqual({ ok: true, data: "AQIDBA==", mimeType: "image/png", hints: [] });
});

test("resizes screenshots and returns Pi coordinate mapping hints", async () => {
	const close = vi.fn();
	const drawImage = vi.fn();
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => ({ drawImage }),
		toDataURL: () => "data:image/png;base64,resized-png",
	};
	vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 2000, close }));
	vi.stubGlobal("document", { createElement: () => canvas });

	const output = await browserReadImageProcessor(new Uint8Array([1]), "image/png", { autoResizeImages: true });

	expect(output).toEqual({
		ok: true,
		data: "resized-png",
		mimeType: "image/png",
		hints: ["[Image: original 4000x2000, displayed at 2000x1000. Multiply coordinates by 2 to map to the original image.]"],
	});
	expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2000, 1000);
	expect(close).toHaveBeenCalledOnce();
});

test("converts BMP reads to PNG even when automatic resizing is disabled", async () => {
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => ({ drawImage: vi.fn() }),
		toDataURL: () => "data:image/png;base64,converted-png",
	};
	vi.stubGlobal("createImageBitmap", async () => ({ width: 32, height: 16, close: vi.fn() }));
	vi.stubGlobal("document", { createElement: () => canvas });

	const output = await browserReadImageProcessor(new Uint8Array([1]), "image/bmp", { autoResizeImages: false });

	expect(output).toEqual({
		ok: true,
		data: "converted-png",
		mimeType: "image/png",
		hints: ["[Image converted from image/bmp to image/png.]"],
	});
});
