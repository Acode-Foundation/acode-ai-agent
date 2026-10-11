import { expect, test } from "vitest";
import type { SessionTreeItem } from "../src/core/types";
import { newestOffBranch, promptVersions } from "../src/ui/sessionTree";

function item(
  id: number,
  parentId: number | null,
  kind: SessionTreeItem["kind"],
  active = false,
): SessionTreeItem {
  return {
    id: String(id),
    parentId: parentId === null ? null : String(parentId),
    type: kind,
    kind,
    text: "",
    timestamp: "",
    active,
    current: false,
  };
}

test("lists the versions of an edited prompt and where each continues", () => {
  // 1 user → 2 answer → 3 user (v1) → 4 answer
  //                   └ 5 user (v2, active) → 6 answer → 7 user → 8 answer
  const items = [
    item(1, null, "user", true),
    item(2, 1, "assistant", true),
    item(3, 2, "user"),
    item(4, 3, "assistant"),
    item(5, 2, "user", true),
    item(6, 5, "assistant", true),
    item(7, 6, "user", true),
    item(8, 7, "assistant", true),
  ];
  const versions = promptVersions(items);
  expect(versions.get("5")).toEqual({ index: 1, ids: ["3", "5"], targets: ["4", "8"] });
  expect(versions.has("1")).toBe(false);
  expect(versions.has("7")).toBe(false);
});

test("a version without an answer yet continues at the prompt itself", () => {
  const items = [item(1, null, "user"), item(2, null, "user", true), item(3, 2, "assistant", true)];
  expect(promptVersions(items).get("2")).toEqual({
    index: 1,
    ids: ["1", "2"],
    targets: ["1", "3"],
  });
});

test("offers the newest entry only when the active branch is empty", () => {
  expect(newestOffBranch([item(1, null, "user"), item(2, 1, "assistant")])).toBe("2");
  expect(
    newestOffBranch([item(1, null, "user", true), item(2, 1, "assistant", true)]),
  ).toBeUndefined();
  expect(newestOffBranch([])).toBeUndefined();
});
