import { expect, test } from "vitest";
import type { SessionTreeItem } from "../src/core/types.ts";
import { countTreeBranches, layoutSessionTree, treeGutterText } from "../src/ui/sessionTree.ts";

function node(
	id: string,
	parentId: string | null,
	kind: SessionTreeItem["kind"],
	extra: Partial<SessionTreeItem> = {},
): SessionTreeItem {
	return {
		id,
		parentId,
		type: "message",
		kind,
		text: extra.text ?? id,
		timestamp: "2026-01-01T00:00:00.000Z",
		active: extra.active ?? false,
		current: extra.current ?? false,
		...extra,
	};
}

test("keeps a linear conversation flat like Pi", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user", { active: true }),
		node("a1", "u1", "assistant", { active: true }),
		node("u2", "a1", "user", { active: true }),
		node("a2", "u2", "assistant", { active: true, current: true }),
	]);
	expect(rows.map((row) => [row.id, row.depth, row.connector])).toEqual([
		["u1", 0, "none"],
		["a1", 0, "none"],
		["u2", 0, "none"],
		["a2", 0, "none"],
	]);
});

test("draws branch connectors and groups the first generation after a split", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user", { active: true }),
		node("a1", "u1", "assistant", { active: true }),
		node("u2a", "a1", "user"),
		node("a2a", "u2a", "assistant"),
		node("u2b", "a1", "user", { active: true }),
		node("a2b", "u2b", "assistant", { active: true, current: true }),
	]);
	expect(rows.map((row) => [row.id, row.depth, row.connector, row.gutters])).toEqual([
		["u1", 0, "none", []],
		["a1", 0, "none", []],
		["u2b", 1, "tee", []],
		["a2b", 2, "none", ["pipe", "blank"]],
		["u2a", 1, "ell", []],
		["a2a", 2, "none", ["blank", "blank"]],
	]);
});

test("puts the active branch first at a fork", () => {
	const rows = layoutSessionTree([
		node("root", null, "user", { active: true }),
		node("old", "root", "user"),
		node("now", "root", "user", { active: true, current: true }),
	]);
	expect(rows.map((row) => row.id)).toEqual(["root", "now", "old"]);
	expect(rows.find((row) => row.id === "now")?.connector).toBe("tee");
	expect(rows.find((row) => row.id === "old")?.connector).toBe("ell");
});

test("user filter reattaches visible prompts to the nearest kept ancestor", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user", { active: true }),
		node("a1", "u1", "assistant", { active: true }),
		node("u2", "a1", "user", { active: true, current: true }),
	], { filter: "user", query: "" });
	expect(rows.map((row) => [row.id, row.kind, row.depth])).toEqual([
		["u1", "user", 0],
		["u2", "user", 0],
	]);
});

test("search keeps matching nodes and their ancestors", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user", { text: "start auth" }),
		node("a1", "u1", "assistant", { text: "plan" }),
		node("u2", "a1", "user", { text: "switch to jwt" }),
	], { filter: "messages", query: "jwt" });
	expect(rows.map((row) => row.id)).toEqual(["u1", "a1", "u2"]);
});

test("folding hides descendants while keeping the foldable node", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user"),
		node("a1", "u1", "assistant"),
		node("u2a", "a1", "user"),
		node("u2b", "a1", "user"),
	], { filter: "messages", query: "", folded: ["a1"] });
	expect(rows.map((row) => [row.id, row.foldable, row.folded])).toEqual([
		["u1", true, false],
		["a1", true, true],
	]);
});

test("marks the latest visible active row current when the leaf is filtered away", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user", { active: true }),
		node("a1", "u1", "assistant", { active: true, current: true }),
	], { filter: "user", query: "" });
	expect(rows).toHaveLength(1);
	expect(rows[0]?.id).toBe("u1");
	expect(rows[0]?.current).toBe(true);
});

test("renders Pi-style gutter glyphs for branch rails", () => {
	const rows = layoutSessionTree([
		node("u1", null, "user", { active: true }),
		node("a1", "u1", "assistant", { active: true }),
		node("left", "a1", "user"),
		node("right", "a1", "user", { active: true, current: true }),
	]);
	expect(treeGutterText(rows.find((row) => row.id === "u1")!)).toBe("");
	expect(treeGutterText(rows.find((row) => row.id === "right")!)).toBe("├─");
	expect(treeGutterText(rows.find((row) => row.id === "left")!)).toBe("└─");
});

test("counts true branch points, not linear turns", () => {
	expect(countTreeBranches([
		node("u1", null, "user"),
		node("a1", "u1", "assistant"),
		node("u2", "a1", "user"),
	])).toBe(0);
	expect(countTreeBranches([
		node("u1", null, "user"),
		node("left", "u1", "user"),
		node("right", "u1", "user"),
	])).toBe(1);
});
