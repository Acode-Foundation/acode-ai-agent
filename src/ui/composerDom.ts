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
	const max = target.nodeType === Node.TEXT_NODE ? (target.textContent?.length ?? 0) : target.childNodes.length;
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
		if (node.dataset.chip === "image") {
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
	return !flattenEditorText(root).replace(/\u00a0/g, " ").trim();
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

export function mentionInEditor(root: HTMLElement): { node: Text; start: number; query: string } | undefined {
	const selection = getEditorSelection(root);
	const nodes = textNodesOutsideChips(root);
	const caretNode = selection?.anchorNode?.nodeType === Node.TEXT_NODE
		&& root.contains(selection.anchorNode)
		&& !selection.anchorNode.parentElement?.closest("[data-chip]")
		? selection.anchorNode as Text
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
		const offset = node === caretNode && selection ? selection.anchorOffset : (node.textContent?.length ?? 0);
		const found = mentionQueryAt(node.textContent ?? "", offset)
			?? mentionQueryAt(node.textContent ?? "", node.textContent?.length ?? 0);
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

function isSelectableRoot(node: Node): node is SelectableRoot & { getSelection(): Selection | null } {
	return node instanceof Document || node instanceof ShadowRoot;
}
