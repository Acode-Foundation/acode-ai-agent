import type { SessionTreeItem } from "../core/types";

export type TreeFilter = "messages" | "user" | "all";
export type TreeGutter = "pipe" | "blank";
export type TreeConnector = "tee" | "ell" | "none";

export type TreeRow = SessionTreeItem & {
  depth: number;
  gutters: TreeGutter[];
  connector: TreeConnector;
  foldable: boolean;
  folded: boolean;
};

const MESSAGE_KINDS = new Set<SessionTreeItem["kind"]>(["user", "assistant", "summary"]);

type GutterMark = { position: number; show: boolean };

type Frame = {
  item: SessionTreeItem;
  indent: number;
  justBranched: boolean;
  showConnector: boolean;
  isLast: boolean;
  gutters: GutterMark[];
  virtualRoot: boolean;
};

export function layoutSessionTree(
  items: SessionTreeItem[],
  options: { filter: TreeFilter; query: string; folded?: Iterable<string> } = {
    filter: "messages",
    query: "",
  },
): TreeRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const allowed = new Set(
    items.filter((item) => passesFilter(item, options.filter)).map((item) => item.id),
  );
  applySearch(byId, allowed, options.query);
  const folded = new Set(options.folded);
  let children = visibleChildren(items, byId, allowed);
  const foldable = new Set<string>();
  for (const [parent, list] of children) {
    if (parent && list.length) foldable.add(parent);
  }
  if (folded.size) {
    hideFoldedDescendants(children, folded, allowed);
    children = visibleChildren(items, byId, allowed);
  }
  for (const [parent, list] of children) children.set(parent, prioritizeActive(list));

  const roots = children.get(null) ?? [];
  const multipleRoots = roots.length > 1;
  const rows: TreeRow[] = [];
  const stack: Frame[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({
      item: roots[index]!,
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      showConnector: multipleRoots,
      isLast: index === roots.length - 1,
      gutters: [],
      virtualRoot: multipleRoots,
    });
  }

  while (stack.length) {
    const frame = stack.pop()!;
    const kids = children.get(frame.item.id) ?? [];
    const displayIndent = multipleRoots ? Math.max(0, frame.indent - 1) : frame.indent;
    const connectorShown = frame.showConnector && !frame.virtualRoot;
    const connector: TreeConnector = connectorShown ? (frame.isLast ? "ell" : "tee") : "none";
    const connectorPosition = Math.max(0, displayIndent - 1);
    const columns = connectorShown ? connectorPosition : displayIndent;
    const gutters: TreeGutter[] = [];
    for (let level = 0; level < columns; level += 1) {
      gutters.push(frame.gutters.find((mark) => mark.position === level)?.show ? "pipe" : "blank");
    }
    rows.push({
      ...frame.item,
      depth: displayIndent,
      gutters,
      connector,
      foldable: foldable.has(frame.item.id),
      folded: folded.has(frame.item.id),
    });

    const branched = kids.length > 1;
    const childIndent =
      branched || (frame.justBranched && frame.indent > 0) ? frame.indent + 1 : frame.indent;
    const childGutters = connectorShown
      ? [...frame.gutters, { position: connectorPosition, show: !frame.isLast }]
      : frame.gutters;
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      stack.push({
        item: kids[index]!,
        indent: childIndent,
        justBranched: branched,
        showConnector: branched,
        isLast: index === kids.length - 1,
        gutters: childGutters,
        virtualRoot: false,
      });
    }
  }

  if (!rows.some((row) => row.current)) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!rows[index]!.active) continue;
      rows[index] = { ...rows[index]!, current: true };
      break;
    }
  }
  return rows;
}

export function countTreeBranches(items: SessionTreeItem[]): number {
  const childCount = new Map<string | null, number>();
  for (const item of items) {
    childCount.set(item.parentId, (childCount.get(item.parentId) ?? 0) + 1);
  }
  let branches = 0;
  for (const count of childCount.values()) if (count > 1) branches += 1;
  return branches;
}

export function treeKindLabel(kind: SessionTreeItem["kind"]): string {
  return kind === "user"
    ? "You"
    : kind === "assistant"
      ? "Agent"
      : kind === "tool"
        ? "Tool"
        : kind === "summary"
          ? "Summary"
          : "State";
}

export function treeGutterText(row: Pick<TreeRow, "gutters" | "connector" | "folded">): string {
  let text = "";
  for (const gutter of row.gutters) text += gutter === "pipe" ? "│ " : "  ";
  if (row.connector === "tee") text += row.folded ? "├+" : "├─";
  else if (row.connector === "ell") text += row.folded ? "└+" : "└─";
  return text;
}

function passesFilter(item: SessionTreeItem, filter: TreeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "user") return item.kind === "user";
  return MESSAGE_KINDS.has(item.kind);
}

function applySearch(
  byId: Map<string, SessionTreeItem>,
  allowed: Set<string>,
  query: string,
): void {
  const needle = query.trim().toLowerCase();
  if (!needle) return;
  for (const id of Array.from(allowed)) {
    const item = byId.get(id);
    if (!item) continue;
    if (`${item.text} ${item.label ?? ""} ${item.type}`.toLowerCase().includes(needle)) continue;
    allowed.delete(id);
  }
  for (const id of Array.from(allowed)) {
    let parent = byId.get(id)?.parentId ?? null;
    while (parent) {
      allowed.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
  }
}

function visibleChildren(
  items: SessionTreeItem[],
  byId: Map<string, SessionTreeItem>,
  allowed: Set<string>,
): Map<string | null, SessionTreeItem[]> {
  const children = new Map<string | null, SessionTreeItem[]>();
  for (const item of items) {
    if (!allowed.has(item.id)) continue;
    let parent = item.parentId;
    while (parent && !allowed.has(parent)) parent = byId.get(parent)?.parentId ?? null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(item);
    else children.set(parent, [item]);
  }
  return children;
}

function hideFoldedDescendants(
  children: Map<string | null, SessionTreeItem[]>,
  folded: Set<string>,
  allowed: Set<string>,
): void {
  const visit = (parent: string | null, hide: boolean) => {
    for (const child of children.get(parent) ?? []) {
      if (hide) allowed.delete(child.id);
      visit(child.id, hide || folded.has(child.id));
    }
  };
  visit(null, false);
}

function prioritizeActive(list: SessionTreeItem[]): SessionTreeItem[] {
  if (list.length < 2) return list;
  const active: SessionTreeItem[] = [];
  const rest: SessionTreeItem[] = [];
  for (const item of list) (item.active ? active : rest).push(item);
  return active.length && rest.length ? [...active, ...rest] : list;
}

/** A prompt that was edited or retried: its versions in order, and where each one continues. */
export type PromptVersions = {
  /** This version's position, from 0. */
  index: number;
  /** Each version's prompt entry, so the switcher can follow a switch before the tree reloads. */
  ids: string[];
  /** For each version, the newest point of its branch, to switch to. */
  targets: string[];
};

/**
 * Versions of each prompt on the active branch, like the `‹ 1/2 ›` switcher of chat apps: the
 * user messages that share its parent, oldest first. Switching opens the newest entry under a
 * version, so the whole branch comes back. Prompts without siblings are left out.
 */
export function promptVersions(items: readonly SessionTreeItem[]): Map<string, PromptVersions> {
  const children = new Map<string | null, SessionTreeItem[]>();
  for (const item of items) {
    const list = children.get(item.parentId) ?? [];
    list.push(item);
    children.set(item.parentId, list);
  }
  const newestUnder = (root: SessionTreeItem): SessionTreeItem => {
    let newest = root;
    const stack = [root];
    while (stack.length) {
      const item = stack.pop()!;
      if (Number(item.id) > Number(newest.id)) newest = item;
      stack.push(...(children.get(item.id) ?? []));
    }
    return newest;
  };
  const versions = new Map<string, PromptVersions>();
  for (const item of items) {
    if (item.kind !== "user" || !item.active) continue;
    const siblings = (children.get(item.parentId) ?? [])
      .filter((sibling) => sibling.kind === "user")
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (siblings.length < 2) continue;
    versions.set(item.id, {
      index: siblings.findIndex((sibling) => sibling.id === item.id),
      ids: siblings.map((sibling) => sibling.id),
      targets: siblings.map((sibling) => newestUnder(sibling).id),
    });
  }
  return versions;
}

/**
 * The newest entry when none of the chat's entries is on the active branch, as after branching
 * before the first prompt; the chat shows it as a way back. Otherwise nothing.
 */
export function newestOffBranch(items: readonly SessionTreeItem[]): string | undefined {
  if (!items.length || items.some((item) => item.active)) return undefined;
  return items.reduce((newest, item) => (Number(item.id) > Number(newest.id) ? item : newest)).id;
}
