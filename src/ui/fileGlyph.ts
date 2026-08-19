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
