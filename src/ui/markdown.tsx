import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type { WorkspaceInfo } from "../core/types";
import { openCustomTab } from "../platform/authTab";
import { highlightCodeBlocks } from "../platform/codeHighlight";
import { PathSandbox } from "../workspace/pathSandbox";
import { copyText, playCopiedFeedback, swapCopyGlyphs } from "./CopyButton";
import { renderMarkdown } from "./markdownRender";

export function Markdown({ text, workspace }: { text: string; workspace?: WorkspaceInfo }) {
	const root = useRef<HTMLDivElement>(null);
	const wrapByIndex = useRef<boolean[]>([]);
	const html = useMemo(() => renderMarkdown(text), [text]);
	useLayoutEffect(() => {
		const host = root.current;
		if (!host) return;
		host.querySelectorAll(".md-code").forEach((block, index) => {
			if (wrapByIndex.current[index]) setCodeWrap(block as HTMLElement, true);
		});
		let cancelled = false;
		void highlightCodeBlocks(host, { cancelled: () => cancelled });
		return () => {
			cancelled = true;
		};
	}, [html]);
	return (
		<div
			ref={root}
			class="md"
			dangerouslySetInnerHTML={{ __html: html }}
			onClick={(event) => onMarkdownClick(event, workspace, wrapByIndex.current)}
		/>
	);
}

function onMarkdownClick(event: MouseEvent, workspace: WorkspaceInfo | undefined, wrapByIndex: boolean[]): void {
	const target = event.target;
	if (!(target instanceof Element)) return;

	const wrapButton = target.closest<HTMLButtonElement>("[data-wrap]");
	if (wrapButton) {
		event.preventDefault();
		const block = wrapButton.closest(".md-code");
		if (!(block instanceof HTMLElement)) return;
		const next = !block.classList.contains("is-wrap");
		setCodeWrap(block, next);
		const index = [...(block.parentElement?.querySelectorAll(".md-code") ?? [])].indexOf(block);
		if (index >= 0) wrapByIndex[index] = next;
		playCopiedFeedback(wrapButton);
		return;
	}

	const copyButton = target.closest<HTMLButtonElement>("[data-copy]");
	if (copyButton) {
		event.preventDefault();
		const code = copyButton.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
		if (!code) return;
		void copyText(code).then(() => markCopied(copyButton));
		return;
	}

	const link = target.closest<HTMLAnchorElement>("a[href]");
	if (!link || !link.closest(".md")) return;

	const kind = link.dataset.kind ?? classifyClickedHref(link.getAttribute("href") ?? "");
	if (kind === "web") {
		event.preventDefault();
		event.stopPropagation();
		void openCustomTab(link.href).catch((error) => {
			console.warn("Could not open link in a custom tab", error);
		});
		return;
	}

	if (kind === "file" || link.dataset.path) {
		event.preventDefault();
		event.stopPropagation();
		openWorkspacePath(link.dataset.path || link.getAttribute("href") || "", workspace);
	}
}

function classifyClickedHref(href: string): "web" | "file" | "plain" {
	if (/^https?:\/\//i.test(href)) return "web";
	if (/^(mailto|tel|sms|javascript):/i.test(href) || href.startsWith("#")) return "plain";
	return "file";
}

function setCodeWrap(block: HTMLElement, wrap: boolean): void {
	block.classList.toggle("is-wrap", wrap);
	const button = block.querySelector<HTMLButtonElement>("[data-wrap]");
	if (!button) return;
	button.classList.toggle("is-on", wrap);
	button.setAttribute("aria-pressed", wrap ? "true" : "false");
	button.setAttribute("aria-label", wrap ? "Unwrap code" : "Wrap code");
	button.title = wrap ? "Unwrap" : "Wrap";
}

function markCopied(button: HTMLButtonElement): void {
	const copy = button.querySelector<HTMLElement>(".md-code-icon-copy");
	const check = button.querySelector<HTMLElement>(".md-code-icon-check");
	button.classList.add("copied");
	button.setAttribute("aria-label", "Copied");
	button.title = "Copied";
	if (copy && check) swapCopyGlyphs(copy, check, true);
	playCopiedFeedback(button);
	window.setTimeout(() => {
		button.classList.remove("copied");
		button.setAttribute("aria-label", "Copy code");
		button.title = "Copy";
		if (copy && check) swapCopyGlyphs(copy, check, false);
	}, 1200);
}

function openWorkspacePath(path: string, workspace?: WorkspaceInfo): void {
	if (typeof acode === "undefined") return;
	const uri = resolveWorkspaceUri(path, workspace);
	if (!uri) return;
	try {
		const existing = window.editorManager?.getFile(uri, "uri");
		if (existing) {
			existing.makeActive();
			return;
		}
		const EditorFile = acode.require("EditorFile");
		const name = uri.split(/[/\\]/).filter(Boolean).at(-1) || uri;
		new EditorFile(name, { uri, render: true });
	} catch {
		// Opening is best-effort for host-specific paths.
	}
}

function resolveWorkspaceUri(path: string, workspace?: WorkspaceInfo): string | undefined {
	const cleaned = path.trim();
	if (!cleaned || /^(https?:|mailto:|tel:|sms:|javascript:|#)/i.test(cleaned)) return undefined;
	if (/^[a-z][a-z\d+.-]*:/i.test(cleaned)) return cleaned;
	if (!workspace?.rootUri || typeof acode?.joinUrl !== "function") return undefined;
	try {
		return new PathSandbox(workspace.rootUri, (root, relative) => acode.joinUrl(root, relative)).resolve(cleaned).uri;
	} catch {
		return undefined;
	}
}
