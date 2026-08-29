import { fileName } from "../workspace/fileMentions";

export function fileIconClass(name: string): string {
	try {
		const helpers = acode.require("helpers") as Acode.Helpers | undefined;
		const cls = helpers?.getIconForFile?.(name);
		if (cls?.includes("file")) return cls;
	} catch {
		// Helpers are optional outside Acode.
	}
	return "file file_type_default";
}

export function createFileGlyph(path: string): HTMLSpanElement {
	const glyph = document.createElement("span");
	glyph.className = `file-glyph ${fileIconClass(fileName(path))}`;
	glyph.setAttribute("aria-hidden", "true");
	return glyph;
}

export function createPasteGlyph(): HTMLSpanElement {
	const glyph = document.createElement("span");
	glyph.className = "paste-glyph";
	glyph.setAttribute("aria-hidden", "true");
	glyph.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
	return glyph;
}
