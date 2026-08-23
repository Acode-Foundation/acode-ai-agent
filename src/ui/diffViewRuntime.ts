import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import type { AcodeDiffViewRuntime } from "../platform/pluginAssets";

const runtime: AcodeDiffViewRuntime = {
	mount(container, input) {
		container.replaceChildren();
		container.setAttribute("aria-label", `Changes in ${input.path}`);
		const view = new EditorView({
			parent: container,
			doc: input.newContents,
			extensions: [
				lineNumbers(),
				EditorView.lineWrapping,
				EditorView.editable.of(false),
				EditorState.readOnly.of(true),
				unifiedMergeView({
					original: input.oldContents,
					highlightChanges: true,
					gutter: true,
					syntaxHighlightDeletions: false,
					allowInlineDiffs: true,
					mergeControls: false,
					collapseUnchanged: { margin: 2, minSize: 6 },
					diffConfig: { scanLimit: 500, timeout: 750 },
				}),
				codeDiffTheme(isDarkSurface(container)),
			],
		});
		return () => {
			view.destroy();
			container.removeAttribute("aria-label");
			container.replaceChildren();
		};
	},
};

window.acodeAiDiffViewRuntime = runtime;

function codeDiffTheme(dark: boolean) {
	return EditorView.theme({
		"&": {
			maxWidth: "100%",
			backgroundColor: "transparent",
			color: "var(--fg)",
			fontSize: "11px",
		},
		"&.cm-focused": { outline: "none" },
		".cm-scroller": {
			maxHeight: "360px",
			overflow: "auto",
			fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
			lineHeight: "18px",
			WebkitOverflowScrolling: "touch",
		},
		".cm-content": { minWidth: "0", padding: "7px 0" },
		".cm-line": { padding: "0 8px" },
		".cm-gutters": {
			border: "none",
			backgroundColor: "color-mix(in srgb, var(--surface) 78%, transparent)",
			color: "var(--muted)",
		},
		".cm-lineNumbers .cm-gutterElement": {
			minWidth: "26px",
			padding: "0 6px 0 4px",
		},
		".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
		".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
			backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
		},
		".cm-collapsedLines": {
			borderTop: "1px solid var(--line)",
			borderBottom: "1px solid var(--line)",
			background: "color-mix(in srgb, var(--surface) 72%, transparent)",
			color: "var(--muted)",
		},
	}, { dark });
}

function isDarkSurface(container: HTMLElement): boolean {
	const root = container.closest<HTMLElement>(".acode-agent-root") ?? container;
	const match = getComputedStyle(root).backgroundColor.match(/[\d.]+/g);
	if (!match || match.length < 3) return true;
	const [red = 0, green = 0, blue = 0] = match.map(Number);
	return (red * 299 + green * 587 + blue * 114) / 1_000 < 128;
}
