import assert from "node:assert/strict";
import test from "node:test";
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
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.type, "message");
	assert.equal(entries[0]?.parentId, null);
	assert.equal(entries[1]?.parentId, entries[0]?.id);
	assert.equal(titleFromEntries(entries), "hello");
});
