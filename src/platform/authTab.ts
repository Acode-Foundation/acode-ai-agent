type TabEvent = { type?: "opened" | "closed" };
type TabOptions = { showTitle: boolean; reportLifecycle?: boolean; authTabId?: string };
let nextAuthTabId = 0;
let activeAuthTabId: string | undefined;
type CustomTabApi = {
  open(
    url: string,
    options?: TabOptions,
    success?: (event?: TabEvent) => void,
    error?: (message: string) => void,
  ): void;
};

type AuthTabOptions = { signal: AbortSignal; onReturn(): void };
type NativeExec = (
  success: (event?: TabEvent) => void,
  error: (message: string) => void,
  service: string,
  action: string,
  args: unknown[],
) => void;

export async function openCustomTab(url: string): Promise<void> {
  return openTab(url);
}

export async function openAuthTab(url: string, options?: AuthTabOptions): Promise<void> {
  return openTab(url, options);
}

export function closeAuthTab(): void {
  const id = activeAuthTabId;
  activeAuthTabId = undefined;
  if (!id) return;
  try {
    // Android returns to the app itself; older hosts may not implement close.
    nativeExec()(
      () => {},
      () => {},
      "CustomTabs",
      "close",
      [id],
    );
  } catch {}
}

function openTab(url: string, options?: AuthTabOptions): Promise<void> {
  const href = secureHttpUrl(url);
  if (options?.signal.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
  const authTabId = options ? `${Date.now()}:${++nextAuthTabId}` : undefined;
  if (authTabId) activeAuthTabId = authTabId;
  const document = globalThis.document;
  let hidden = false;
  let returned = false;
  let rejectOpening: (error: Error) => void = () => {};
  const cleanup = () => {
    document?.removeEventListener("resume", onReturn);
    document?.removeEventListener("visibilitychange", onVisibility);
    options?.signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    cleanup();
    if (activeAuthTabId === authTabId) activeAuthTabId = undefined;
    rejectOpening(new DOMException("Sign-in cancelled", "AbortError"));
  };
  const onReturn = () => {
    if (returned || options?.signal.aborted) return;
    returned = true;
    cleanup();
    options?.onReturn();
  };
  const onVisibility = () => {
    if (document.hidden) hidden = true;
    else if (hidden) onReturn();
  };
  return new Promise<void>((resolve, reject) => {
    rejectOpening = reject;
    if (options) {
      document?.addEventListener("resume", onReturn);
      document?.addEventListener("visibilitychange", onVisibility);
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const opened = (event?: TabEvent) => {
      if (event?.type === "closed") onReturn();
      resolve();
      if (!options) cleanup();
    };
    const failed = (message: string) => {
      cleanup();
      if (activeAuthTabId === authTabId) activeAuthTabId = undefined;
      reject(new Error(message || "Could not open the browser."));
    };
    try {
      const tabs = (globalThis as { CustomTabs?: CustomTabApi }).CustomTabs;
      const tabOptions: TabOptions = {
        showTitle: true,
        ...(options ? { reportLifecycle: true, authTabId } : {}),
      };
      if (tabs?.open) tabs.open(href, tabOptions, opened, failed);
      else nativeExec()(opened, failed, "CustomTabs", "open", [href, tabOptions]);
    } catch (error) {
      cleanup();
      if (activeAuthTabId === authTabId) activeAuthTabId = undefined;
      reject(error);
    }
  });
}

function nativeExec(): NativeExec {
  const exec = (globalThis as { cordova?: { exec?: NativeExec } }).cordova?.exec;
  if (!exec) throw new Error("Acode's native browser bridge is required.");
  return exec;
}

function secureHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Sign-in URL must be http(s).");
  }
  return url.href;
}
