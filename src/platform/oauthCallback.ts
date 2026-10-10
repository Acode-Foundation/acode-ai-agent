export const OPENROUTER_CALLBACK_URL = "https://acode.app/ai/oauth/openrouter";
const APP_CALLBACK_URL = "acode://ai-agent/oauth/openrouter";
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;

/** Registers before browser launch, so a fast callback cannot arrive ahead of the listener. */
export function waitForOpenRouterCallback(
  state: string,
  signal: AbortSignal | undefined,
  onReady: () => void,
  timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<string> {
  const intent = (globalThis as { acode?: typeof acode }).acode?.require("intent");
  if (!intent?.addHandler || !intent.removeHandler)
    return Promise.reject(
      new Error("Update Acode for automatic browser sign-in, or use an API key."),
    );
  if (signal?.aborted) return Promise.reject(new DOMException("Sign-in cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, code?: string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      intent.removeHandler(onIntent);
      if (error) reject(error);
      else resolve(code!);
    };
    const onAbort = () => finish(new DOMException("Sign-in cancelled", "AbortError"));
    const onIntent = (event: Acode.IntentEvent & { url?: string }) => {
      if (event.module !== "ai-agent" || event.action !== "oauth") return;
      let callback: URL;
      try {
        callback = new URL(event.url ?? `acode://ai-agent/oauth/${event.value}`);
      } catch {
        return;
      }
      const location = callback.protocol + "//" + callback.host + callback.pathname;
      if (![APP_CALLBACK_URL, OPENROUTER_CALLBACK_URL].includes(location)) return;
      if (callback.username || callback.password || callback.hash) return;
      const states = callback.searchParams.getAll("state");
      if (states.length !== 1 || states[0] !== state) return;
      event.preventDefault();
      event.stopPropagation();
      if (callback.searchParams.has("error")) {
        finish(new Error("OpenRouter authorization was denied or failed. Try signing in again."));
        return;
      }
      const codes = callback.searchParams.getAll("code");
      if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
        finish(new Error("OpenRouter did not return a valid authorization code."));
        return;
      }
      finish(undefined, codes[0]);
    };
    const timer = setTimeout(
      () => finish(new Error("Sign-in expired. Try signing in again.")),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      intent.addHandler(onIntent);
      onReady();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
