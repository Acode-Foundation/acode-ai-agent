import assert from "node:assert/strict";
import test from "node:test";
import { portableCodexOAuth, portableXaiOAuth } from "../src/providers/portableOAuth.ts";

test("xAI refresh keeps a non-rotated refresh token", async () => {
	const restore = stubFetch({ access_token: "next-access", expires_in: 3600 });
	try {
		const credential = await portableXaiOAuth.refresh({
			type: "oauth",
			access: "old-access",
			refresh: "stable-refresh",
			expires: 0,
		});
		assert.equal(credential.access, "next-access");
		assert.equal(credential.refresh, "stable-refresh");
		assert.deepEqual(await portableXaiOAuth.toAuth(credential), { apiKey: "next-access" });
	} finally {
		restore();
	}
});

test("Codex refresh extracts the ChatGPT account claim", async () => {
	const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } });
	const restore = stubFetch({ access_token: access, refresh_token: "next-refresh", expires_in: 1800 });
	try {
		const credential = await portableCodexOAuth.refresh({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
		});
		assert.equal(credential.accountId, "account-123");
		assert.equal(credential.refresh, "next-refresh");
		assert.deepEqual(await portableCodexOAuth.toAuth(credential), { apiKey: access });
	} finally {
		restore();
	}
});

function stubFetch(body: Record<string, unknown>): () => void {
	const previous = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
	return () => { globalThis.fetch = previous; };
}

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.`;
}
