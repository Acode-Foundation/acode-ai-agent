import { expect, test } from "vitest";
import type { ChatSummary } from "../src/core/types.ts";
import { filterChats } from "../src/ui/sidebar/SidebarApp.tsx";

const chats: ChatSummary[] = [
	{ id: "older", title: "Fix parser", workspaceId: "alpha", workspaceName: "Compiler", updatedAt: 10, running: false },
	{ id: "newer", title: "Build dashboard", workspaceId: "beta", workspaceName: "Studio", updatedAt: 20, running: true },
];

test("sorts sidebar sessions by recent activity", () => {
	expect(filterChats(chats, "").map((chat) => chat.id)).toEqual(["newer", "older"]);
});

test("filters sessions by title or workspace", () => {
	expect(filterChats(chats, "parser").map((chat) => chat.id)).toEqual(["older"]);
	expect(filterChats(chats, "studio").map((chat) => chat.id)).toEqual(["newer"]);
	expect(filterChats(chats, "", "alpha").map((chat) => chat.id)).toEqual(["older"]);
});
