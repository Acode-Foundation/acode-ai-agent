import { expect, test } from "vitest";
import { parseChatIndex, parseSettings, permissionModeSchema } from "../src/core/schema.ts";

test("settings accept permission modes and migrate unknown junk", () => {
	const settings = parseSettings({
		providerId: "openrouter",
		modelId: "x",
		permissionMode: "full-access",
		customModels: { openrouter: ["a/b"] },
	});
	expect(settings.permissionMode).toBe("full-access");
	expect(settings.customModels.openrouter).toEqual(["a/b"]);
	expect(permissionModeSchema.parse("ask")).toBe("ask");
});

test("chat index drops malformed rows", () => {
	expect(parseChatIndex({ chats: [{ id: "1", title: "Hi", workspaceId: "w", updatedAt: 1 }] })).toHaveLength(1);
	expect(parseChatIndex({ chats: [{ title: "bad" }] })).toEqual([]);
});
