import type { WorkspaceInfo } from "../core/types";
import { PathSandbox } from "../workspace/pathSandbox";

/** Open a workspace-relative path in Acode's editor. Host integration is best-effort. */
export function openWorkspaceFile(path: string, workspace?: WorkspaceInfo): boolean {
	const uri = resolveWorkspaceUri(path, workspace);
	if (!uri || typeof acode === "undefined") return false;
	try {
		const existing = window.editorManager?.getFile(uri, "uri");
		if (existing) {
			existing.makeActive();
			return true;
		}
		const fileBrowser = acode.require("fileBrowser") as FileBrowser | undefined;
		const name = uri.split(/[/\\]/).filter(Boolean).at(-1) || uri;
		if (typeof fileBrowser?.openFile === "function") {
			fileBrowser.openFile({ type: "file", url: uri, name });
			return true;
		}
		acode.newEditorFile(name, { uri, render: true });
		return true;
	} catch {
		return false;
	}
}

export function resolveWorkspaceUri(path: string, workspace?: WorkspaceInfo): string | undefined {
	const cleaned = path.trim().replace(/^\.\//, "");
	if (!cleaned || /^(https?:|mailto:|tel:|sms:|javascript:|#)/i.test(cleaned)) return undefined;
	if (/^[a-z][a-z\d+.-]*:/i.test(cleaned)) return cleaned;
	if (!workspace?.rootUri || typeof acode === "undefined" || typeof acode.joinUrl !== "function") return undefined;
	try {
		return new PathSandbox(workspace.rootUri, (root, relative) => acode.joinUrl(root, relative)).resolve(cleaned).uri;
	} catch {
		return undefined;
	}
}
