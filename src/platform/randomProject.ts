import type { WorkspaceInfo } from "../core/types";
import { getAvailableWorkspaces, subscribeToSidebarFolders } from "../workspace/sidebarFolders";

const ADJECTIVES = [
	"amber", "brisk", "cedar", "clear", "ember", "lunar", "moss", "quiet", "solar", "swift",
] as const;
const NOUNS = [
	"atlas", "cove", "forge", "grove", "harbor", "kite", "orbit", "pixel", "relay", "studio",
] as const;
const FALLBACK_TERMINAL_HOME = "file:///data/user/0/com.foxdebug.acode/files/public/";
const WORKSPACE_WAIT_MS = 12_000;

export function randomProjectName(random: () => number = Math.random): string {
	const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(0.9999, v)) : 0);
	const adj = ADJECTIVES[Math.floor(clamp(random()) * ADJECTIVES.length)]!;
	const noun = NOUNS[Math.floor(clamp(random()) * NOUNS.length)]!;
	const suffix = Math.floor(10 + clamp(random()) * 90);
	return `${adj}-${noun}-${suffix}`;
}

export async function terminalHomeUrl(): Promise<string> {
	if (typeof globalThis.system?.getFilesDir === "function") {
		try {
			const filesDir = await new Promise<string>((resolve, reject) => globalThis.system?.getFilesDir(resolve, reject));
			if (filesDir) return acode.joinUrl(`file://${filesDir}`, "public");
		} catch {}
	}

	if (typeof globalThis.BuildInfo?.packageName === "string") {
		return `file:///data/user/0/${globalThis.BuildInfo.packageName}/files/public/`;
	}

	return FALLBACK_TERMINAL_HOME;
}

export async function createHomeProject(requestedName?: string): Promise<WorkspaceInfo> {
	let name = requestedName ?? randomProjectName();
	const fs = acode.require("fs") ?? acode.fsOperation;
	const openFolder = acode.require("openFolder") ?? acode.require("openfolder");
	if (!fs || !openFolder) throw new Error("Acode filesystem and Open Folder APIs are required.");

	const homeUrl = await terminalHomeUrl();
	let projectUrl = acode.joinUrl(homeUrl, name);

	for (let i = 0; i < 5; i++) {
		try {
			if (!(await fs(projectUrl).exists())) {
				await fs(homeUrl).createDirectory(name);
				break;
			}
		} catch {}
		if (requestedName) throw new Error(`Project ${name} already exists.`);
		name = randomProjectName();
		projectUrl = acode.joinUrl(homeUrl, name);
	}

	const before = new Set(getAvailableWorkspaces().map((w) => w.id));
	const waiting = waitForWorkspace(name, projectUrl, before);
	openFolder(projectUrl, { name, saveState: true });
	return waiting;
}

export function formatPlatformError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	const helpers = acode.require("helpers");
	const msg = helpers?.errorMessage?.(error as Error);
	if (typeof msg === "string" && msg) return msg;
	if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
		return (error as { message: string }).message;
	}
	return "Unknown filesystem error";
}

function waitForWorkspace(name: string, projectUrl: string, previousIds: Set<string>): Promise<WorkspaceInfo> {
	return new Promise((resolve, reject) => {
		const Url = acode.require("Url");
		const isSame = (a: string, b: string) => Url?.areSame?.(a, b) ?? a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
		const check = () => {
			const found = getAvailableWorkspaces().find((w) =>
				(!previousIds.has(w.id) || isSame(w.rootUri, projectUrl))
				&& (isSame(w.rootUri, projectUrl) || w.name === name)
			);
			if (found) {
				cleanup();
				resolve(found);
			}
		};

		const unsubscribe = subscribeToSidebarFolders(check);
		const timer = setInterval(check, 100);
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Project created at ${name}, but Acode did not add it to the sidebar.`));
		}, WORKSPACE_WAIT_MS);

		const cleanup = () => {
			unsubscribe();
			clearInterval(timer);
			clearTimeout(timeout);
		};

		check();
	});
}
