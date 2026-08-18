import { useMemo } from "preact/hooks";
import type { WorkspaceInfo } from "../core/types";
import { openCustomTab } from "../platform/authTab";
import { PathSandbox } from "../workspace/pathSandbox";
import { copyText } from "./CopyButton";
import { renderMarkdown } from "./markdownRender";

export function Markdown({ text, workspace }: { text: string; workspace?: WorkspaceInfo }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return (
		<div
			class="md"
			dangerouslySetInnerHTML={{ __html: html }}
			onClick={(event) => onMarkdownClick(event, workspace)}
		/>
	);
}

function onMarkdownClick(event: MouseEvent, workspace?: WorkspaceInfo): void {
	const target = event.target;
	if (!(target instanceof Element)) return;

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

function markCopied(button: HTMLButtonElement): void {
	const previous = button.textContent;
	button.classList.add("copied");
	button.textContent = "Copied";
	window.setTimeout(() => {
		button.classList.remove("copied");
		button.textContent = previous || "Copy";
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
