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
	expect(parseChatIndex({ chats: [{ id: "1", title: "Hi", workspaceId: "w", workspaceName: "Demo", updatedAt: 1 }] })).toEqual([
		{ id: "1", title: "Hi", workspaceId: "w", workspaceName: "Demo", updatedAt: 1 },
	]);
	expect(parseChatIndex({ chats: [{ id: "2", title: "Legacy", workspaceId: "w", updatedAt: 1 }] })[0]?.workspaceName).toBe("");
	expect(parseChatIndex({ chats: [{ title: "bad" }] })).toEqual([]);
});
