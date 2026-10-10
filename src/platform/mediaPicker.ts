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
    const cleanup = () => {
      input.removeEventListener("change", selected);
      input.removeEventListener("cancel", cancelled);
      input.remove();
    };
    const selected = () => {
      const file = input.files?.[0];
      cleanup();
      resolve(file);
    };
    const cancelled = () => {
      cleanup();
      resolve(undefined);
    };
    input.addEventListener("change", selected);
    input.addEventListener("cancel", cancelled);
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
