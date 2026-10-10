import { mentionQueryAt } from "../workspace/fileMentions";

type SelectableRoot = Document | ShadowRoot;

export function getEditorSelection(node: Node | null | undefined): Selection | null {
  if (!node) return document.getSelection();
  const root = node.getRootNode();
  if (isSelectableRoot(root) && typeof root.getSelection === "function") {
    try {
      const selected = root.getSelection();
      if (selected) return selected;
    } catch {
      // Some WebViews expose getSelection but reject it.
    }
  }
  return node.ownerDocument?.getSelection() ?? document.getSelection();
}

export function setCaret(root: HTMLElement, target: Node, offset = 0): void {
  const range = root.ownerDocument.createRange();
  const max =
    target.nodeType === Node.TEXT_NODE
      ? (target.textContent?.length ?? 0)
      : target.childNodes.length;
  range.setStart(target, Math.max(0, Math.min(offset, max)));
  range.collapse(true);
  const selection = getEditorSelection(root);
  try {
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // Shadow selections in older WebViews cannot take a foreign Range.
  }
}

export function flattenEditorText(root: HTMLElement): string {
  const chunks: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) {
      node.childNodes.forEach(visit);
      return;
    }
    if (node.dataset.chip === "file") {
      chunks.push(`@${node.dataset.path ?? ""}`);
      return;
    }
    if (
      node.dataset.chip === "image" ||
      node.dataset.chip === "attachment" ||
      node.dataset.chip === "paste"
    ) {
      chunks.push(" ");
      return;
    }
    if (node.tagName === "BR") {
      chunks.push("\n");
      return;
    }
    node.childNodes.forEach(visit);
    if ((node.tagName === "DIV" || node.tagName === "P") && node !== root) chunks.push("\n");
  };
  root.childNodes.forEach(visit);
  return chunks.join("");
}

export function isBlankEditor(root: HTMLElement): boolean {
  if (root.querySelector("[data-chip]")) return false;
  return !flattenEditorText(root)
    .replace(/\u00a0/g, " ")
    .trim();
}

export function clearBlankEditor(root: HTMLElement): void {
  if (!isBlankEditor(root)) return;
  if (!root.childNodes.length) return;
  root.replaceChildren();
  setCaret(root, root, 0);
}

export function textNodesOutsideChips(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const visit = (node: Node) => {
    if (node instanceof HTMLElement && node.dataset.chip) return;
    if (node.nodeType === Node.TEXT_NODE) {
      nodes.push(node as Text);
      return;
    }
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return nodes;
}

export function mentionInEditor(
  root: HTMLElement,
): { node: Text; start: number; query: string } | undefined {
  const selection = getEditorSelection(root);
  const nodes = textNodesOutsideChips(root);
  const caretNode =
    selection?.anchorNode?.nodeType === Node.TEXT_NODE &&
    root.contains(selection.anchorNode) &&
    !selection.anchorNode.parentElement?.closest("[data-chip]")
      ? (selection.anchorNode as Text)
      : undefined;
  const seen = new Set<Text>();
  const order: Text[] = [];
  if (caretNode) {
    order.push(caretNode);
    seen.add(caretNode);
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (seen.has(node)) continue;
    order.push(node);
  }
  for (const node of order) {
    const offset =
      node === caretNode && selection ? selection.anchorOffset : (node.textContent?.length ?? 0);
    const found =
      mentionQueryAt(node.textContent ?? "", offset) ??
      mentionQueryAt(node.textContent ?? "", node.textContent?.length ?? 0);
    if (found) return { node, start: found.start, query: found.query };
  }
  return undefined;
}

export function consumeMention(root: HTMLElement): boolean {
  const found = mentionInEditor(root);
  if (!found) return false;
  const value = found.node.textContent ?? "";
  found.node.textContent = `${value.slice(0, found.start)}${value.slice(found.start + 1 + found.query.length)}`;
  if (!found.node.textContent) {
    const parent = found.node.parentNode ?? root;
    const index = [...parent.childNodes].indexOf(found.node);
    found.node.remove();
    setCaret(root, parent, Math.max(0, index));
    return true;
  }
  setCaret(root, found.node, found.start);
  return true;
}

export function chipBesideCaret(
  root: HTMLElement,
  direction: "backward" | "forward",
  targetRange?: StaticRange,
): HTMLElement | null {
  const selection = getEditorSelection(root);
  if (!selection?.isCollapsed) return null;
  // beforeinput exposes the real deletion boundary even when a shadow selection is retargeted.
  const anchorNode = targetRange
    ? direction === "backward"
      ? targetRange.endContainer
      : targetRange.startContainer
    : selection.anchorNode;
  const anchorOffset = targetRange
    ? direction === "backward"
      ? targetRange.endOffset
      : targetRange.startOffset
    : selection.anchorOffset;
  if (!anchorNode || !root.contains(anchorNode)) return null;
  const chip = (
    anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement
  )?.closest<HTMLElement>("[data-chip]");
  if (chip && root.contains(chip)) return chip;
  if (anchorNode.nodeType === Node.TEXT_NODE) {
    const atEdge =
      direction === "backward"
        ? anchorOffset === 0
        : anchorOffset === (anchorNode.textContent?.length ?? 0);
    const onlySpace = /^\u00a0?$/.test(anchorNode.textContent ?? "");
    if (atEdge || onlySpace) {
      const sibling = adjacentElement(root, anchorNode, direction);
      if (sibling?.dataset.chip) return sibling;
    }
  }
  if (anchorNode === root || (anchorNode instanceof HTMLElement && !anchorNode.dataset.chip)) {
    const index = direction === "backward" ? anchorOffset - 1 : anchorOffset;
    const child = anchorNode.childNodes[index];
    if (child instanceof HTMLElement && child.dataset.chip) return child;
    if (child?.nodeType === Node.TEXT_NODE && /^\u00a0?$/.test(child.textContent ?? "")) {
      const sibling = adjacentElement(root, child, direction);
      if (sibling?.dataset.chip) return sibling;
    }
  }
  return null;
}

function adjacentElement(
  root: HTMLElement,
  node: Node,
  direction: "backward" | "forward",
): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== root) {
    const sibling: ChildNode | null =
      direction === "backward" ? current.previousSibling : current.nextSibling;
    if (sibling instanceof HTMLElement) return sibling;
    if (sibling?.nodeType === Node.TEXT_NODE && /^\u00a0?$/.test(sibling.textContent ?? "")) {
      current = sibling;
      continue;
    }
    if (sibling) return sibling instanceof HTMLElement ? sibling : null;
    current = current.parentNode;
    if (current instanceof HTMLElement && current.dataset.chip) return current;
  }
  return null;
}

function isSelectableRoot(
  node: Node,
): node is SelectableRoot & { getSelection(): Selection | null } {
  return node instanceof Document || node instanceof ShadowRoot;
}
