import assert from "node:assert/strict";
import test from "node:test";
import { parseChatIndex, parseSettings, permissionModeSchema } from "../src/core/schema.ts";

test("settings accept permission modes and migrate unknown junk", () => {
	const settings = parseSettings({
		providerId: "openrouter",
		modelId: "x",
		permissionMode: "full-access",
		customModels: { openrouter: ["a/b"] },
	});
	assert.equal(settings.permissionMode, "full-access");
	assert.deepEqual(settings.customModels.openrouter, ["a/b"]);
	assert.equal(permissionModeSchema.parse("ask"), "ask");
});

test("chat index drops malformed rows", () => {
	assert.deepEqual(parseChatIndex({ chats: [{ id: "1", title: "Hi", workspaceId: "w", updatedAt: 1 }] }).length, 1);
	assert.deepEqual(parseChatIndex({ chats: [{ title: "bad" }] }), []);
});
