import { getEditorSelection } from "./composerDom";

/** Temporarily use the host's normal text IME without changing the editor preference. */
export function bindPromptKeyboard(element: HTMLElement): () => void {
  let restoreMode: string | undefined;
  let generation = 0;
  let reconnecting = false;
  let composing = false;
  let pendingReconnect: (() => void) | undefined;
  const focused = () =>
    element.getRootNode() instanceof ShadowRoot
      ? (element.getRootNode() as ShadowRoot).activeElement === element
      : element.ownerDocument.activeElement === element;
  const setMode = (mode: string, ready = () => {}) => system?.setInputType?.(mode, ready, () => {});
  const enable = () => {
    if (restoreMode !== undefined) return;
    try {
      const mode = acode.require("settings").value.keyboardMode;
      if (typeof mode !== "string" || typeof system?.setInputType !== "function") return;
      restoreMode = mode;
      const request = ++generation;
      const reconnect = () => {
        const host = globalThis as {
          cordova?: { platformId?: string };
          Bridge?: { platformId?: string };
        };
        if (
          (host.Bridge ?? host.cordova)?.platformId !== "android" ||
          request !== generation ||
          !element.isConnected ||
          !focused()
        )
          return;
        if (composing) {
          pendingReconnect = reconnect;
          return;
        }
        // Android applies the override when creating an input connection, not to the
        // connection already opened by this focus. Reconnect after the bridge confirms it.
        const selection = getEditorSelection(element);
        const ranges = selection
          ? Array.from({ length: selection.rangeCount }, (_, i) =>
              selection.getRangeAt(i).cloneRange(),
            )
          : [];
        reconnecting = true;
        try {
          element.blur();
          element.focus({ preventScroll: true });
          if (selection && ranges.length) {
            selection.removeAllRanges();
            for (const range of ranges) selection.addRange(range);
          }
        } catch {
          // Older WebViews can reject restoring a shadow-root selection.
        } finally {
          reconnecting = false;
        }
      };
      setMode("NORMAL", reconnect);
    } catch {
      restoreMode = undefined;
      // Browser previews and older hosts may not expose the native keyboard bridge.
    }
  };
  const restore = () => {
    if (reconnecting) return;
    ++generation;
    pendingReconnect = undefined;
    composing = false;
    if (restoreMode === undefined) return;
    let previous = restoreMode;
    restoreMode = undefined;
    try {
      previous = acode.require("settings").value.keyboardMode ?? previous;
    } catch {
      // Keep the captured preference if settings are unavailable during teardown.
    }
    try {
      setMode(previous);
    } catch {
      // The host may already be tearing down when the plugin is unmounted.
    }
  };
  const refresh = () => {
    if (!document.hidden && focused() && element.getClientRects().length) enable();
    else restore();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    const reconnect = pendingReconnect;
    pendingReconnect = undefined;
    reconnect?.();
  };
  element.addEventListener("focus", enable);
  element.addEventListener("blur", restore);
  element.addEventListener("compositionstart", onCompositionStart);
  element.addEventListener("compositionend", onCompositionEnd);
  window.addEventListener("blur", restore);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  if (typeof editorManager !== "undefined") editorManager.on("switch-file", refresh);
  if (focused()) enable();
  return () => {
    element.removeEventListener("focus", enable);
    element.removeEventListener("blur", restore);
    element.removeEventListener("compositionstart", onCompositionStart);
    element.removeEventListener("compositionend", onCompositionEnd);
    window.removeEventListener("blur", restore);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
    if (typeof editorManager !== "undefined") editorManager.off("switch-file", refresh);
    restore();
  };
}
