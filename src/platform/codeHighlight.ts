export type CodeHighlightApi = {
	highlightCodeBlock(code: string, language?: string | null): Promise<string>;
	applyStyles?(root?: Document | ShadowRoot | ParentNode | Element | null): unknown;
	HIGHLIGHT_CLASS?: string;
};

/** Host highlighter, or `null` on Acode builds that do not expose it yet. */
export function getCodeHighlight(): CodeHighlightApi | null {
	try {
		if (typeof acode === "undefined" || typeof acode.require !== "function") {
			return null;
		}
		const api = acode.require("codeHighlight") as CodeHighlightApi | undefined;
		if (!api || typeof api.highlightCodeBlock !== "function") return null;
		return api;
	} catch {
		return null;
	}
}

/**
 * Highlight fenced markdown blocks in place when the host API exists.
 * Leaves escaped source untouched if the API is missing or highlighting fails.
 */
export async function highlightCodeBlocks(
	root: ParentNode,
	options: { cancelled?: () => boolean } = {},
): Promise<void> {
	const api = getCodeHighlight();
	if (!api) return;

	applyHostStyles(api, root);

	const blocks = [...root.querySelectorAll<HTMLElement>(".md-code pre code")];
	await Promise.all(
		blocks.map(async (code) => {
			if (code.dataset.cmHighlighted === "1") return;
			const language = code.closest(".md-code")?.getAttribute("data-lang") ?? "";
			const source = code.textContent ?? "";
			if (!source.trim()) return;
			try {
				const html = await api.highlightCodeBlock(source, language || undefined);
				if (options.cancelled?.() || !code.isConnected) return;
				if (!html) return;
				const highlightClass = api.HIGHLIGHT_CLASS || "cm-highlighted";
				code.classList.add(highlightClass);
				code.closest("pre")?.classList.add(highlightClass);
				code.innerHTML = html;
				code.dataset.cmHighlighted = "1";
			} catch {
				// Keep the original escaped source.
			}
		}),
	);
}

function applyHostStyles(api: CodeHighlightApi, root: ParentNode): void {
	if (typeof api.applyStyles !== "function") return;
	const styleRoot =
		typeof Element !== "undefined" && root instanceof Element
			? root.getRootNode()
			: root;
	try {
		api.applyStyles(styleRoot as Document | ShadowRoot);
	} catch {
		// Highlighting still works; token colors may be missing.
	}
}
