import type { WorkspaceInfo } from "../core/types";
import { workspaceId } from "./pathSandbox";

function acodeHost(): typeof acode | undefined {
	return (globalThis as typeof globalThis & { acode?: typeof acode }).acode;
}

export function getAddedFolders(): Acode.Folder[] {
	const fromApi = acodeHost()?.require("addedfolder");
	const folders = Array.isArray(fromApi) ? fromApi : (globalThis as typeof globalThis & { addedFolder?: Acode.Folder[] }).addedFolder;
	if (!Array.isArray(folders)) return [];
	return folders.filter((folder): folder is Acode.Folder => Boolean(folder && typeof folder.url === "string" && folder.url));
}

export function getAvailableWorkspaces(): WorkspaceInfo[] {
	return getAddedFolders().map((folder) => workspaceFromFolder(folder));
}

export function workspaceFromFolder(folder: Acode.Folder): WorkspaceInfo {
	const rootUri = folder.url;
	const scheme = /^([a-z][a-z\d+.-]*):/i.exec(rootUri)?.[1]?.toLowerCase() ?? "file";
	return {
		id: workspaceId(rootUri),
		name: folder.title || rootUri.split("/").pop() || "Workspace",
		rootUri,
		scheme,
		remote: scheme === "ftp" || scheme === "sftp",
	};
}

export function subscribeToSidebarFolders(listener: () => void): () => void {
	const manager = window.editorManager;
	if (!manager?.on) return () => undefined;
	manager.on("add-folder", listener);
	manager.on("remove-folder", listener);
	manager.on("update-folder", listener);
	return () => {
		manager.off("add-folder", listener);
		manager.off("remove-folder", listener);
		manager.off("update-folder", listener);
	};
}
