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

test("maps a SAF tree root onto descendants that include the document id", () => {
	const tree = "content://com.android.externalstorage.documents/tree/primary%3ACodes";
	const documentRoot = `${tree}::primary:Codes`;
	const sandbox = new PathSandbox(tree, join);
	expect(sandbox.relative(documentRoot)).toBe("");
	expect(sandbox.relative(`${documentRoot}/src/main.ts`)).toBe("src/main.ts");
	expect(sandbox.relative(`${tree}::primary:Codes/app/index.js`)).toBe("app/index.js");
	expect(sandbox.resolve("src/main.ts").relativePath).toBe("src/main.ts");
	expect(sandbox.resolve("primary:Codes/src/main.ts")).toEqual({
		relativePath: "src/main.ts",
		uri: `${tree}/src/main.ts`,
	});
	expect(sandbox.resolve("primary:Codes").relativePath).toBe("");
});

test("maps a SAF folder opened as tree::documentId without leaking the document id", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ACodes::primary:Codes";
	const sandbox = new PathSandbox(root, join);
	expect(sandbox.relative(root)).toBe("");
	expect(sandbox.relative(`${root}/src/main.ts`)).toBe("src/main.ts");
	expect(sandbox.relative("content://com.android.externalstorage.documents/tree/primary%3ACodes::primary:Codes/lib/util.ts")).toBe("lib/util.ts");
	expect(sandbox.resolve("primary:Codes/src/main.ts").relativePath).toBe("src/main.ts");
});

test("maps nested SAF folders the same way as the tree root", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ACodes::primary:Codes/app";
	const sandbox = new PathSandbox(root, join);
	expect(sandbox.relative(`${root}/src/main.ts`)).toBe("src/main.ts");
	expect(sandbox.resolve("src/main.ts").relativePath).toBe("src/main.ts");
	expect(sandbox.resolve("primary:Codes/app/src/main.ts").relativePath).toBe("src/main.ts");
});

test("maps Termux SAF document ids that start with an absolute unix path", () => {
	const tree = "content://com.termux.documents/tree/%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome%2Fproj";
	const sandbox = new PathSandbox(tree, join);
	expect(sandbox.relative(`${tree}::/data/data/com.termux/files/home/proj/src/main.ts`)).toBe("src/main.ts");
});

test("maps file-index records onto workspace-relative paths", () => {
	const root = "content://com.android.externalstorage.documents/tree/primary%3ADev";
	const sandbox = new PathSandbox(root, join);
	expect(workspaceRelativeFromIndex({ url: `${root}::src/main.ts`, name: "main.ts" }, sandbox, "Dev")).toBe("src/main.ts");
	expect(workspaceRelativeFromIndex({ path: "Dev/src/main.ts", name: "main.ts" }, sandbox, "Dev")).toBe("src/main.ts");
	expect(workspaceRelativeFromIndex({ path: "Dev", name: "Dev" }, sandbox, "Dev")).toBe("");
	expect(workspaceRelativeFromIndex({ path: "src/main.ts", name: "main.ts" }, sandbox, "Dev")).toBe("src/main.ts");
	expect(workspaceRelativeFromIndex(
		{ url: `${root}::primary:Dev/src/main.ts`, path: "primary:Dev/src/main.ts", name: "main.ts" },
		sandbox,
		"Dev",
	)).toBe("src/main.ts");
	expect(workspaceRelativeFromIndex(
		{ path: "primary:Dev/src/main.ts", name: "main.ts" },
		sandbox,
		"Dev",
	)).toBe("src/main.ts");
});

test("matches indexed parent URIs with or without a trailing slash", () => {
	expect(sameParentUri("file:///project/src", "file:///project/src/")).toBe(true);
	expect(sameParentUri("file:///project/src", "file:///project")).toBe(false);
});

test("treats a SAF tree URI and its document-id form as the same folder", () => {
	const tree = "content://com.android.externalstorage.documents/tree/primary%3ACodes";
	expect(sameParentUri(tree, `${tree}::primary:Codes`)).toBe(true);
	expect(sameParentUri(`${tree}/`, `${tree}::primary:Codes/`)).toBe(true);
	expect(sameParentUri(tree, `${tree}::primary:Codes/src`)).toBe(false);
	expect(sameParentUri(`${tree}::primary:Codes/src`, `${tree}::primary:Codes/src/`)).toBe(true);
});

test("still rejects URI schemes that are not this workspace's SAF document id", () => {
	const sandbox = new PathSandbox("file:///project", join);
	expect(() => sandbox.resolve("primary:Codes/src/main.ts")).toThrow();
	expect(() => sandbox.resolve("content://other/tree/root::file.ts")).toThrow();
});

/** Mirrors Acode `Url.join` for ftp/sftp/file: keep `?mode=&security=` on the end. */
function acodeJoin(root: string, path: string): string {
	const queryAt = root.search(/[?#]/);
	const url = (queryAt >= 0 ? root.slice(0, queryAt) : root).replace(/\/+$/, "");
	const query = queryAt >= 0 ? root.slice(queryAt) : "";
	return `${url}/${path.replace(/^\/+/, "")}${query}`;
}

test("maps an Acode file:// storage-manager folder", () => {
	const root = "file:///storage/emulated/0/Codes";
	const sandbox = new PathSandbox(root, acodeJoin);
	expect(sandbox.relative(root)).toBe("");
	expect(sandbox.relative(`${root}/src/main.ts`)).toBe("src/main.ts");
	expect(sandbox.relative("file:///storage/emulated/0/Other/src/main.ts")).toBeUndefined();
	expect(sandbox.resolve("src/main.ts")).toEqual({
		relativePath: "src/main.ts",
		uri: "file:///storage/emulated/0/Codes/src/main.ts",
	});
	expect(workspaceRelativeFromIndex(
		{ url: `${root}/src/main.ts`, path: "Codes/src/main.ts", name: "main.ts" },
		sandbox,
		"Codes",
	)).toBe("src/main.ts");
});

test("maps an Acode FTP folder from Url.formate (user, password, port, mode, security)", () => {
	const root = "ftp://alice:p%40ss@ftp.example.com:21/www/?mode=passive&security=ftp";
	const file = "ftp://alice:p%40ss@ftp.example.com:21/www/src/main.ts?mode=passive&security=ftp";
	const sandbox = new PathSandbox(root, acodeJoin);
	expect(sandbox.relative(root)).toBe("");
	expect(sandbox.relative("ftp://alice:p%40ss@ftp.example.com:21/www?mode=passive&security=ftp")).toBe("");
	expect(sandbox.relative(file)).toBe("src/main.ts");
	expect(sandbox.relative("ftp://alice:p%40ss@ftp.example.com:21/www/lib/util.ts?mode=passive&security=ftp")).toBe("lib/util.ts");
	expect(sandbox.relative("ftp://alice:p%40ss@ftp.example.com:21/other/src/main.ts?mode=passive&security=ftp")).toBeUndefined();
	expect(sandbox.resolve("src/main.ts")).toEqual({
		relativePath: "src/main.ts",
		uri: "ftp://alice:p%40ss@ftp.example.com:21/www/src/main.ts?mode=passive&security=ftp",
	});
	expect(workspaceRelativeFromIndex({ url: file, path: "www/src/main.ts", name: "main.ts" }, sandbox, "www")).toBe("src/main.ts");
	expect(sameParentUri(root, "ftp://alice:p%40ss@ftp.example.com:21/www?mode=passive&security=ftp")).toBe(true);
	expect(sameParentUri(root, file)).toBe(false);
});

test("maps an Acode FTPS active-mode storage root", () => {
	const root = "ftp://alice:secret@ftp.example.com:21/?mode=active&security=ftps";
	const sandbox = new PathSandbox(root, acodeJoin);
	expect(sandbox.relative("ftp://alice:secret@ftp.example.com:21/public_html/index.html?mode=active&security=ftps")).toBe("public_html/index.html");
	expect(sandbox.resolve("public_html/index.html").uri).toBe(
		"ftp://alice:secret@ftp.example.com:21/public_html/index.html?mode=active&security=ftps",
	);
});

test("maps an Acode FTP folder that only has a username", () => {
	const root = "ftp://anonymous@ftp.example.com:21/public_html?mode=passive&security=ftp";
	const sandbox = new PathSandbox(root, acodeJoin);
	expect(sandbox.relative("ftp://anonymous@ftp.example.com:21/public_html/css/app.css?mode=passive&security=ftp")).toBe("css/app.css");
	expect(sandbox.relative("ftp://anonymous@other.example.com:21/public_html/css/app.css?mode=passive&security=ftp")).toBeUndefined();
});

test("maps an Acode SFTP profile URL (sftp://profile-id/path)", () => {
	const root = "sftp://profile-k3m9x2ab/home/alice/Codes";
	const file = "sftp://profile-k3m9x2ab/home/alice/Codes/src/main.ts";
	const sandbox = new PathSandbox(root, acodeJoin);
	expect(sandbox.relative(root)).toBe("");
	expect(sandbox.relative(`${root}/`)).toBe("");
	expect(sandbox.relative(file)).toBe("src/main.ts");
	expect(sandbox.relative("sftp://profile-k3m9x2ab/home/alice/Other/src/main.ts")).toBeUndefined();
	expect(sandbox.relative("sftp://profile-other/home/alice/Codes/src/main.ts")).toBeUndefined();
	expect(sandbox.resolve("lib/util.ts")).toEqual({
		relativePath: "lib/util.ts",
		uri: "sftp://profile-k3m9x2ab/home/alice/Codes/lib/util.ts",
	});
	expect(workspaceRelativeFromIndex({ url: file, path: "Codes/src/main.ts", name: "main.ts" }, sandbox, "Codes")).toBe("src/main.ts");
	expect(sameParentUri(root, `${root}/`)).toBe(true);
});

test("maps an Acode SFTP storage root created by createSftpProfileUrl", () => {
	const root = "sftp://profile-k3m9x2ab/";
	const sandbox = new PathSandbox(root, acodeJoin);
	expect(sandbox.relative("sftp://profile-k3m9x2ab")).toBe("");
	expect(sandbox.relative("sftp://profile-k3m9x2ab/home/alice/Codes/src/main.ts")).toBe("home/alice/Codes/src/main.ts");
	expect(sandbox.resolve("home/alice/Codes/src/main.ts").uri).toBe("sftp://profile-k3m9x2ab/home/alice/Codes/src/main.ts");
});

test("does not mix Acode ftp, sftp profile, file, and SAF workspaces", () => {
	const ftp = new PathSandbox("ftp://alice:secret@ftp.example.com:21/www?mode=passive&security=ftp", acodeJoin);
	const sftp = new PathSandbox("sftp://profile-k3m9x2ab/home/alice/Codes", acodeJoin);
	const file = new PathSandbox("file:///storage/emulated/0/Codes", acodeJoin);
	const saf = new PathSandbox("content://com.android.externalstorage.documents/tree/primary%3ACodes", join);
	expect(ftp.relative("sftp://profile-k3m9x2ab/www/src/main.ts")).toBeUndefined();
	expect(ftp.relative("content://com.android.externalstorage.documents/tree/primary%3ACodes::primary:Codes/src/main.ts")).toBeUndefined();
	expect(sftp.relative("ftp://alice:secret@ftp.example.com:21/home/alice/Codes/src/main.ts?mode=passive&security=ftp")).toBeUndefined();
	expect(sftp.relative("file:///home/alice/Codes/src/main.ts")).toBeUndefined();
	expect(file.relative("ftp://alice:secret@ftp.example.com:21/storage/emulated/0/Codes/src/main.ts?mode=passive&security=ftp")).toBeUndefined();
	expect(saf.relative("sftp://profile-k3m9x2ab/Codes/src/main.ts")).toBeUndefined();
	expect(saf.relative("ftp://alice:secret@ftp.example.com:21/Codes/src/main.ts?mode=passive&security=ftp")).toBeUndefined();
	expect(saf.relative("file:///storage/emulated/0/Codes/src/main.ts")).toBeUndefined();
	expect(sameParentUri(
		"ftp://alice:secret@ftp.example.com:21/www?mode=passive&security=ftp",
		"sftp://profile-k3m9x2ab/www",
	)).toBe(false);
});

test("strips credentials from Acode FTP and legacy SFTP URLs", () => {
	const ftp = "ftp://alice:secret@ftp.example.com:21/www?mode=passive&security=ftp";
	const legacySftp = "sftp://alice:secret@git.example.com/project?password=secret&keyFile=/private/key";
	expect(stripCredentials(ftp)).toBe("ftp://ftp.example.com/www");
	expect(stripCredentials(legacySftp)).toBe("sftp://git.example.com/project");
	expect(workspaceId(ftp)).toBe(workspaceId("ftp://alice:other@ftp.example.com:21/www?mode=active&security=ftps"));
	expect(workspaceId(legacySftp)).toBe(workspaceId("sftp://alice:other@git.example.com/project?password=other"));
	expect(workspaceId(ftp).includes("secret")).toBe(false);
	expect(workspaceId("sftp://profile-k3m9x2ab/home/alice/Codes")).not.toBe(workspaceId(ftp));
});

test("maps an SD-card SAF volume the same way as primary storage", () => {
	const tree = "content://com.android.externalstorage.documents/tree/ABCD-1234%3AProjects";
	const sandbox = new PathSandbox(tree, join);
	expect(sandbox.relative(`${tree}::ABCD-1234:Projects`)).toBe("");
	expect(sandbox.relative(`${tree}::ABCD-1234:Projects/src/main.ts`)).toBe("src/main.ts");
	expect(sandbox.resolve("ABCD-1234:Projects/lib/util.ts").relativePath).toBe("lib/util.ts");
	expect(sameParentUri(tree, `${tree}::ABCD-1234:Projects`)).toBe(true);
	expect(sameParentUri(tree, `${tree}::ABCD-1234:Other`)).toBe(false);
});

test("maps a primary-volume SAF root so Codes is a normal child folder", () => {
	const tree = "content://com.android.externalstorage.documents/tree/primary%3A";
	const sandbox = new PathSandbox(tree, join);
	expect(sandbox.relative(`${tree}::primary:`)).toBe("");
	expect(sandbox.relative(`${tree}::primary:Codes/src/main.ts`)).toBe("Codes/src/main.ts");
	expect(sandbox.resolve("primary:Codes/src/main.ts").relativePath).toBe("Codes/src/main.ts");
	expect(sandbox.resolve("Codes/src/main.ts").relativePath).toBe("Codes/src/main.ts");
});

test("maps Acode public-storage SAF document ids", () => {
	const tree = "content://com.foxdebug.acode.documents/tree/%2Fdata%2Fuser%2F0%2Fcom.foxdebug.acode%2Ffiles%2Fpublic";
	const doc = "/data/user/0/com.foxdebug.acode/files/public";
	const sandbox = new PathSandbox(tree, join);
	expect(sandbox.relative(`${tree}::${doc}`)).toBe("");
	expect(sandbox.relative(`${tree}::${doc}/plugin.json`)).toBe("plugin.json");
	expect(sandbox.relative(`${tree}::${doc}/src/main.ts`)).toBe("src/main.ts");
});

test("maps Termux SAF whether the folder was opened as a tree or as tree::docId", () => {
	const tree = "content://com.termux.documents/tree/%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome%2Fproj";
	const doc = "/data/data/com.termux/files/home/proj";
	const asTree = new PathSandbox(tree, join);
	const asDocument = new PathSandbox(`${tree}::${doc}`, join);
	expect(asTree.relative(`${tree}::${doc}`)).toBe("");
	expect(asTree.relative(`${tree}::${doc}/src/main.ts`)).toBe("src/main.ts");
	expect(asDocument.relative(`${tree}::${doc}/src/main.ts`)).toBe("src/main.ts");
	expect(sameParentUri(tree, `${tree}::${doc}`)).toBe(true);
	expect(asTree.relative(`${tree}::/data/data/com.termux/files/home/other/src/main.ts`)).toBeUndefined();
});
