import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chipBesideCaret } from "../src/ui/composerDom";

// A small tree fixture exercises both text offsets and WebKit's element-boundary offsets.
class TreeNode {
  static TEXT_NODE = 3;
  parentNode: TreeNode | null = null;
  childNodes: TreeNode[] = [];
  constructor(
    public nodeType = 1,
    public textContent = "",
  ) {}
  append(...nodes: TreeNode[]) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  contains(node: TreeNode): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }
  getRootNode() {
    return ownerDocument;
  }
  get previousSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): ElementNode | null {
    return this.parentNode instanceof ElementNode ? this.parentNode : null;
  }
}
class ElementNode extends TreeNode {
  dataset: Record<string, string> = {};
  closest(): ElementNode | null {
    return this.dataset.chip ? this : (this.parentElement?.closest() ?? null);
  }
}
class DocumentNode {
  getSelection() {
    return selection;
  }
}
let ownerDocument: DocumentNode;
let selection: { anchorNode: TreeNode; anchorOffset: number; isCollapsed: boolean } | null;

beforeEach(() => {
  ownerDocument = new DocumentNode();
  selection = null;
  vi.stubGlobal("document", ownerDocument);
  vi.stubGlobal("Document", DocumentNode);
  vi.stubGlobal("ShadowRoot", class {});
  vi.stubGlobal("Node", TreeNode);
  vi.stubGlobal("HTMLElement", ElementNode);
});
afterEach(() => vi.unstubAllGlobals());

function fixture(text = "\u00a0@", imageFirst = true) {
  const root = new ElementNode();
  const image = new ElementNode();
  image.dataset.chip = "image";
  const typed = new TreeNode(3, text);
  root.append(...(imageFirst ? [image, typed] : [typed, image]));
  const caret = (node: TreeNode, offset: number, collapsed = true) => {
    selection = { anchorNode: node, anchorOffset: offset, isCollapsed: collapsed };
  };
  const beside = (direction: "backward" | "forward" = "backward") =>
    chipBesideCaret(root as unknown as HTMLElement, direction);
  return { root, image, typed, caret, beside };
}

test("Backspace after @ with an element-boundary caret leaves the image for native text deletion", () => {
  const { root, caret, beside } = fixture();
  caret(root, 2);
  expect(beside()).toBeNull();
});

test("Delete before @ with an element-boundary caret leaves the image", () => {
  const { root, caret, beside } = fixture("@", false);
  caret(root, 0);
  expect(beside("forward")).toBeNull();
});

test("text-node offsets delete the typed character before touching an image", () => {
  const { typed, caret, beside } = fixture();
  caret(typed, 2);
  expect(beside()).toBeNull();
  caret(typed, 1);
  expect(beside("forward")).toBeNull();
});

test.each(["backward", "forward"] as const)(
  "%s removes an immediately adjacent chip",
  (direction) => {
    const { root, image, caret, beside } = fixture("", direction === "backward");
    caret(root, 1);
    expect(beside(direction)).toBe(image);
  },
);

test("the inserted nonbreaking space permits chip deletion from text or parent offsets", () => {
  const { root, typed, image, caret, beside } = fixture("\u00a0");
  caret(typed, 1);
  expect(beside()).toBe(image);
  caret(root, 2);
  expect(beside()).toBe(image);
});

test("typed spaces are deleted normally instead of removing the image", () => {
  const { root, typed, caret, beside } = fixture(" ");
  caret(root, 2);
  expect(beside()).toBeNull();
  caret(typed, 1);
  expect(beside()).toBeNull();
});

test("a range selection or unavailable/outside selection never guesses an attachment to remove", () => {
  const { root, caret, beside } = fixture();
  caret(root, 1, false);
  expect(beside()).toBeNull();
  caret(new ElementNode(), 0);
  expect(beside()).toBeNull();
  selection = null;
  expect(beside()).toBeNull();
});

test("walking adjacent nodes stops at typed text", () => {
  const { root, caret, beside } = fixture("@");
  const gap = new TreeNode(3, "\u00a0");
  root.append(gap);
  caret(gap, 1);
  expect(beside()).toBeNull();
});

test("Backspace treats an image label's caret as part of the atomic chip", () => {
  const { image, caret, beside } = fixture();
  const label = new ElementNode();
  const text = new TreeNode(3, "image.png");
  label.append(text);
  image.append(label);
  caret(text, text.textContent.length);
  expect(beside()).toBe(image);
});

test("mobile deletion uses its target range when the shadow caret is retargeted", () => {
  const { root, image, typed, caret } = fixture("\u00a0");
  caret(new ElementNode(), 0);
  const range = {
    startContainer: root,
    startOffset: 0,
    endContainer: typed,
    endOffset: 1,
  } as unknown as StaticRange;
  expect(chipBesideCaret(root as unknown as HTMLElement, "backward", range)).toBe(image);
  typed.textContent = "@";
  expect(chipBesideCaret(root as unknown as HTMLElement, "backward", range)).toBeNull();
});
