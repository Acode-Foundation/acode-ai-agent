import { expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntriesFromMessages, titleFromEntries } from "../src/session/sessionText.ts";

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

test("turns a flat message array into a linear session tree", () => {
	const entries = sessionEntriesFromMessages([
		user("hello", 10),
		user("again", 20),
	]);
	expect(entries).toHaveLength(2);
	expect(entries[0]?.type).toBe("message");
	expect(entries[0]?.parentId).toBeNull();
	expect(entries[1]?.parentId).toBe(entries[0]?.id);
	expect(titleFromEntries(entries)).toBe("hello");
});
