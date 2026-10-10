const RETURN_GRACE_MS = 1_000;
// Photos from iCloud or HEIC conversion can report the selection well after the app regains focus.
const LATE_SELECTION_MS = 60 * 1_000;

/** Keep the click synchronous so iOS preserves the user's gesture and opens its media chooser. */
export function pickMediaFile(): Promise<File | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText =
      "position:fixed;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
    let settled = false;
    let returnTimer: ReturnType<typeof setTimeout> | undefined;
    // Older WebViews may omit cancel; also bound hosts that emit no return event at all.
    const timeout = setTimeout(selected, 10 * 60 * 1_000);
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(returnTimer);
      input.removeEventListener("change", selected);
      input.removeEventListener("cancel", selected);
      window.removeEventListener("focus", returned);
      document.removeEventListener("resume", returned);
      document.removeEventListener("visibilitychange", visibilityChanged);
      input.remove();
    };
    function selected() {
      if (settled) return;
      settled = true;
      const file = input.files?.[0];
      cleanup();
      resolve(file);
    }
    const returned = () => {
      // Focus can precede change when the native chooser hands a selected file back.
      if (settled || returnTimer !== undefined) return;
      returnTimer = setTimeout(() => {
        if (input.files?.length) selected();
        else returnTimer = setTimeout(selected, LATE_SELECTION_MS);
      }, RETURN_GRACE_MS);
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") returned();
    };
    input.addEventListener("change", selected);
    input.addEventListener("cancel", selected);
    window.addEventListener("focus", returned);
    document.addEventListener("resume", returned);
    document.addEventListener("visibilitychange", visibilityChanged);
    try {
      document.body.append(input);
      input.click();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}
