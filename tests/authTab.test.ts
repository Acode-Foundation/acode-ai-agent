import assert from "node:assert/strict";
import test from "node:test";
import { openAuthTab } from "../src/platform/authTab.ts";

test("opens sign-in in Acode custom tabs with the default browser session", async () => {
	const opened: Array<{ url: string; options?: unknown }> = [];
	const previous = (globalThis as { CustomTabs?: unknown }).CustomTabs;
	(globalThis as { CustomTabs: { open: typeof CustomTabs.open } }).CustomTabs = {
		open(url, options, success) {
			opened.push({ url, options });
			success?.();
		},
	};
	try {
		await openAuthTab("https://auth.example.test/device");
		assert.deepEqual(opened, [{
			url: "https://auth.example.test/device",
			options: { showTitle: true },
		}]);
	} finally {
		if (previous) (globalThis as { CustomTabs?: unknown }).CustomTabs = previous;
		else delete (globalThis as { CustomTabs?: unknown }).CustomTabs;
	}
});

test("falls back to cordova CustomTabs when the global helper is missing", async () => {
	const calls: unknown[][] = [];
	const previousTabs = (globalThis as { CustomTabs?: unknown }).CustomTabs;
	const previousCordova = (globalThis as { cordova?: unknown }).cordova;
	delete (globalThis as { CustomTabs?: unknown }).CustomTabs;
	(globalThis as { cordova: { exec: (...args: unknown[]) => void } }).cordova = {
		exec(success, _error, service, action, args) {
			calls.push([service, action, args]);
			(success as () => void)();
		},
	};
	try {
		await openAuthTab("https://auth.openai.com/codex/device");
		assert.deepEqual(calls, [[
			"CustomTabs",
			"open",
			["https://auth.openai.com/codex/device", { showTitle: true }],
		]]);
	} finally {
		if (previousTabs) (globalThis as { CustomTabs?: unknown }).CustomTabs = previousTabs;
		else delete (globalThis as { CustomTabs?: unknown }).CustomTabs;
		if (previousCordova) (globalThis as { cordova?: unknown }).cordova = previousCordova;
		else delete (globalThis as { cordova?: unknown }).cordova;
	}
});

test("rejects non-http sign-in URLs", async () => {
	await assert.rejects(() => openAuthTab("javascript:alert(1)"), /http/);
});
