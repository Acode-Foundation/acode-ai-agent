import type { WorkspaceInfo } from "../core/types";
import { getAvailableWorkspaces, subscribeToSidebarFolders } from "../workspace/sidebarFolders";

const ADJECTIVES = [
  "amber",
  "brisk",
  "cedar",
  "clear",
  "ember",
  "lunar",
  "moss",
  "quiet",
  "solar",
  "swift",
] as const;
const NOUNS = [
  "atlas",
  "cove",
  "forge",
  "grove",
  "harbor",
  "kite",
  "orbit",
  "pixel",
  "relay",
  "studio",
] as const;
const HOME_DIRECTORY = "public";
const WORKSPACE_WAIT_MS = 12_000;

export function randomProjectName(random: () => number = Math.random): string {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(0.9999, v)) : 0);
  const adj = ADJECTIVES[Math.floor(clamp(random()) * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(clamp(random()) * NOUNS.length)]!;
  const suffix = Math.floor(10 + clamp(random()) * 90);
  return `${adj}-${noun}-${suffix}`;
}

function validProjectName(value: string): boolean {
  const name = value.trim();
  // Acode uses the folder name as a single file URL segment.
  return (
    !!name &&
    name !== "." &&
    name !== ".." &&
    !/[\\/%?#:]/.test(name) &&
    new TextEncoder().encode(name).length <= 255 &&
    !Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

export async function promptProjectName(): Promise<string | null> {
  // Acode pushes this entry synchronously and removes it on Back, even on
  // hosts where Back closes the dialog without settling its promise.
  if (acode.require("actionStack")?.has?.("prompt")) return null;
  const options = { required: true, capitalize: false, test: validProjectName };
  return acode.prompt("New project name", randomProjectName(), "text", options);
}

export async function terminalFilesUrl(): Promise<string> {
  if (typeof globalThis.system?.getFilesDir === "function") {
    try {
      const filesDir = await new Promise<string>((resolve, reject) =>
        globalThis.system?.getFilesDir(resolve, reject),
      );
      if (filesDir) return `file://${filesDir}`;
    } catch {}
  }

  const packageName = globalThis.BuildInfo?.packageName ?? "com.foxdebug.acode";
  return `file:///data/user/0/${packageName}/files`;
}

export async function createHomeProject(requestedName?: string): Promise<WorkspaceInfo> {
  let name = requestedName?.trim() ?? randomProjectName();
  if (!validProjectName(name)) throw new Error("Enter a valid project folder name.");
  const fs = acode.require("fs") ?? acode.fsOperation;
  const openFolder = acode.require("openFolder") ?? acode.require("openfolder");
  if (!fs || !openFolder) throw new Error("Acode filesystem and Open Folder APIs are required.");

  const filesUrl = await terminalFilesUrl();
  const homeUrl = acode.joinUrl(filesUrl, HOME_DIRECTORY);
  // On a fresh installation the terminal may not have created Home yet.
  const home = fs(homeUrl);
  if (!(await home.exists())) {
    await fs(filesUrl).createDirectory(HOME_DIRECTORY);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const projectUrl = acode.joinUrl(homeUrl, name);
    if (await fs(projectUrl).exists()) {
      if (requestedName !== undefined) throw new Error(`Project ${name} already exists.`);
      name = randomProjectName();
      continue;
    }
    await home.createDirectory(name);
    const before = new Set(getAvailableWorkspaces().map((w) => w.id));
    openFolder(projectUrl, { name, saveState: true });
    return waitForWorkspace(name, projectUrl, before);
  }
  throw new Error("Could not find an unused project name.");
}

export function formatPlatformError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const helpers = acode.require("helpers");
  const msg = helpers?.errorMessage?.(error as Error);
  if (typeof msg === "string" && msg) return msg;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "Unknown filesystem error";
}

function waitForWorkspace(
  name: string,
  projectUrl: string,
  previousIds: Set<string>,
): Promise<WorkspaceInfo> {
  return new Promise((resolve, reject) => {
    const Url = acode.require("Url");
    const isSame = (a: string, b: string) =>
      Url?.areSame?.(a, b) ?? a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
    const check = () => {
      const found = getAvailableWorkspaces().find(
        (w) =>
          (!previousIds.has(w.id) || isSame(w.rootUri, projectUrl)) &&
          (isSame(w.rootUri, projectUrl) || w.name === name),
      );
      if (found) {
        cleanup();
        resolve(found);
      }
    };

    const unsubscribe = subscribeToSidebarFolders(check);
    const timer = setInterval(check, 250);
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
