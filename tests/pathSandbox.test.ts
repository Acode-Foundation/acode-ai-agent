import { expect, test } from "vitest";
import { PathSandbox, sameParentUri, stripCredentials, workspaceId, workspaceRelativeFromIndex } from "../src/workspace/pathSandbox.ts";

const join = (root: string, path: string) => `${root.replace(/\/$/, "")}/${path}`;

test("normalizes safe workspace-relative paths", () => {
	const sandbox = new PathSandbox("file:///project", join);
	expect(sandbox.resolve("./src//main.ts")).toEqual({
		relativePath: "src/main.ts",
		uri: "file:///project/src/main.ts",
	});
});

test("rejects traversal, schemes, absolute paths, backslashes, and null bytes", () => {
	const sandbox = new PathSandbox("content://provider/tree/root", join);
	for (const unsafe of ["../secret", "src/../../secret", "%2e%2e/secret", "%252e%252e/secret", "/etc/passwd", "%2Fetc/passwd", "file:///tmp/a", "%66ile%3A///tmp/a", "sftp://host/a", "src\\main.ts", "safe?password=oops", "a\0b"]) {
		expect(() => sandbox.resolve(unsafe)).toThrow();
	}
});

test("does not expose credentials in persisted workspace identities", () => {
	const first = "sftp://alice:secret@example.com/project?password=secret&keyFile=/private/key";
	const second = "sftp://alice:different@example.com/project?password=different";
	expect(stripCredentials(first)).toBe("sftp://example.com/project");
	expect(workspaceId(first)).toBe(workspaceId(second));
	expect(workspaceId(first).includes("secret")).toBe(false);
});

test("maps Acode SAF descendants back to relative paths", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ADev";
	const sandbox = new PathSandbox(root, join);
	expect(sandbox.relative(`${root}::src/main.ts`)).toBe("src/main.ts");
	expect(sandbox.relative("content://another/root")).toBeUndefined();
	expect(sandbox.relative(undefined)).toBeUndefined();
	expect(sandbox.relative(null)).toBeUndefined();
	expect(sandbox.relative("")).toBeUndefined();
});

test("maps file-index records onto workspace-relative paths", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ADev";
	const sandbox = new PathSandbox(root, join);
	expect(workspaceRelativeFromIndex({ url: `${root}::src/main.ts`, name: "main.ts" }, sandbox, "Dev")).toBe("src/main.ts");
	expect(workspaceRelativeFromIndex({ path: "Dev/src/main.ts", name: "main.ts" }, sandbox, "Dev")).toBe("src/main.ts");
	expect(workspaceRelativeFromIndex({ path: "src/main.ts", name: "main.ts" }, sandbox, "Dev")).toBe("src/main.ts");
});

test("matches indexed parent URIs with or without a trailing slash", () => {
	expect(sameParentUri("file:///project/src", "file:///project/src/")).toBe(true);
	expect(sameParentUri("file:///project/src", "file:///project")).toBe(false);
});
