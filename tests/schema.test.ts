import { DEFAULT_COMPACTION_POLICY as DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { isPermissionMode, parseSettings } from "../src/core/schema.ts";
import { DEFAULT_SETTINGS } from "../src/core/settings.ts";

test("settings accept permission modes and migrate unknown junk", () => {
  const settings = parseSettings({
    providerId: "openrouter",
    modelId: "x",
    permissionMode: "full-access",
    customModels: { openrouter: ["a/b"] },
  });
  expect(settings.permissionMode).toBe("full-access");
  expect(settings.customModels.openrouter).toEqual(["a/b"]);
  expect(isPermissionMode("ask")).toBe(true);
  expect(isPermissionMode("root")).toBe(false);
  expect(parseSettings({ permissionMode: "root", maxWalkFiles: 9_999 })).toMatchObject({
    permissionMode: "ask",
    maxWalkFiles: 200,
  });
});

test("compaction defaults come from Pi instead of a local copy", () => {
  expect(DEFAULT_SETTINGS.autoCompaction).toBe(DEFAULT_COMPACTION_SETTINGS.enabled);
  expect(DEFAULT_SETTINGS.compactionReserveTokens).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  expect(DEFAULT_SETTINGS.compactionKeepRecentTokens).toBe(
    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  );
  expect(parseSettings({}).compactionReserveTokens).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  expect(parseSettings({}).showTaskTray).toBe(true);
  expect(DEFAULT_SETTINGS.showTaskTray).toBe(true);
  expect(parseSettings({}).customEndpoints).toEqual([]);
  expect(DEFAULT_SETTINGS.customEndpoints).toEqual([]);
});
