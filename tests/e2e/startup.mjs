export class CdpUnavailableError extends Error {}

// Retry only startup discovery/transport failures. Once the test starts, failures
// must surface instead of reconnecting to a page that lost the injected test state.
export async function waitForAcode(pages, evaluate, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await pages(Math.min(10_000, deadline - Date.now()));
      const main = targets.find((page) => page.url === "https://localhost/index.html");
      if (!main) throw new CdpUnavailableError("Acode WebView target is not available");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const snapshot = await evaluate(
        main,
        `({
          debug:globalThis.BuildInfo?.debug,
          emulator:globalThis.device?.isVirtual,
          version:globalThis.BuildInfo?.version,
          code:globalThis.BuildInfo?.versionCode,
          webview:navigator.userAgent,
          ready:Boolean(window.ad && window.editorManager?.activeFile && !document.body.classList.contains('loading'))
        })`,
        Math.min(10_000, remaining),
      );
      if (snapshot == null)
        throw new CdpUnavailableError("Acode startup snapshot is not available");
      if (snapshot.debug === false || snapshot.emulator === false)
        throw new Error("This test resets consent: use a disposable debug emulator");
      if (snapshot.debug === true && snapshot.emulator === true && snapshot.ready) {
        const { ready: _ready, ...environment } = snapshot;
        return { main, environment };
      }
    } catch (error) {
      if (!(error instanceof CdpUnavailableError)) throw error;
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
  }
  throw new Error(
    "Timed out waiting for Acode startup; check the CDP forwarding, startup prompts, and emulator network." +
      (lastError ? ` Last CDP error: ${lastError.message}` : ""),
    { cause: lastError },
  );
}
