import assert from "node:assert/strict";
import test from "node:test";
import { PathSandbox, sameParentUri, stripCredentials, workspaceId, workspaceRelativeFromIndex } from "../src/workspace/pathSandbox.ts";

const join = (root: string, path: string) => `${root.replace(/\/$/, "")}/${path}`;

test("normalizes safe workspace-relative paths", () => {
	const sandbox = new PathSandbox("file:///project", join);
	assert.deepEqual(sandbox.resolve("./src//main.ts"), {
		relativePath: "src/main.ts",
		uri: "file:///project/src/main.ts",
	});
});

test("rejects traversal, schemes, absolute paths, backslashes, and null bytes", () => {
	const sandbox = new PathSandbox("content://provider/tree/root", join);
	for (const unsafe of ["../secret", "src/../../secret", "%2e%2e/secret", "%252e%252e/secret", "/etc/passwd", "%2Fetc/passwd", "file:///tmp/a", "%66ile%3A///tmp/a", "sftp://host/a", "src\\main.ts", "safe?password=oops", "a\0b"]) {
		assert.throws(() => sandbox.resolve(unsafe));
	}
});

test("does not expose credentials in persisted workspace identities", () => {
	const first = "sftp://alice:secret@example.com/project?password=secret&keyFile=/private/key";
	const second = "sftp://alice:different@example.com/project?password=different";
	assert.equal(stripCredentials(first), "sftp://example.com/project");
	assert.equal(workspaceId(first), workspaceId(second));
	assert.equal(workspaceId(first).includes("secret"), false);
});

test("maps Acode SAF descendants back to relative paths", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ADev";
	const sandbox = new PathSandbox(root, join);
	assert.equal(sandbox.relative(`${root}::src/main.ts`), "src/main.ts");
	assert.equal(sandbox.relative("content://another/root"), undefined);
	assert.equal(sandbox.relative(undefined), undefined);
	assert.equal(sandbox.relative(null), undefined);
	assert.equal(sandbox.relative(""), undefined);
});

test("maps file-index records onto workspace-relative paths", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ADev";
	const sandbox = new PathSandbox(root, join);
	assert.equal(workspaceRelativeFromIndex({ url: `${root}::src/main.ts`, name: "main.ts" }, sandbox, "Dev"), "src/main.ts");
	assert.equal(workspaceRelativeFromIndex({ path: "Dev/src/main.ts", name: "main.ts" }, sandbox, "Dev"), "src/main.ts");
	assert.equal(workspaceRelativeFromIndex({ path: "src/main.ts", name: "main.ts" }, sandbox, "Dev"), "src/main.ts");
});

test("matches indexed parent URIs with or without a trailing slash", () => {
	assert.equal(sameParentUri("file:///project/src", "file:///project/src/"), true);
	assert.equal(sameParentUri("file:///project/src", "file:///project"), false);
});
