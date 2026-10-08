/** Selectors of Acode's file icons and of icon-theme plugins (`file-icon--…`). */
const ICON_SELECTOR = /file_type_|file-icon--/;

/**
 * Acode renders the agent inside a tab's shadow root, which does not see the file-icon
 * rules in the main document, including those an icon-theme plugin adds. Copy those rules
 * into a stylesheet the shadow root adopts, and refresh it when the document's styles
 * change, so file rows use the same icons as Acode's sidebar. Returns a cleanup function.
 */
export function shareFileIconStyles(node: Node): () => void {
  const root = node.getRootNode();
  if (typeof ShadowRoot === "undefined" || !(root instanceof ShadowRoot)) return () => undefined;
  if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype))
    return () => undefined;
  const sheet = new CSSStyleSheet();
  let last = "";
  const sync = () => {
    const css = collectIconRules();
    if (css === last) return;
    last = css;
    sheet.replaceSync(css);
  };
  sync();
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(sync, 300);
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => {
    clearTimeout(timer);
    observer.disconnect();
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((item) => item !== sheet);
  };
}

function collectIconRules(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue; // Cross-origin sheets cannot be read.
    }
    for (const rule of Array.from(list))
      if (rule instanceof CSSStyleRule && ICON_SELECTOR.test(rule.selectorText))
        rules.push(rule.cssText);
  }
  return rules.join("\n");
}
