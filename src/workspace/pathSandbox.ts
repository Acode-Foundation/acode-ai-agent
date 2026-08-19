export type JoinUrl = (root: string, path: string) => string;

export class PathSandbox {
	readonly rootUri: string;
	#join: JoinUrl;
	#rootSaf: SafDocument | undefined;

	constructor(rootUri: string, join: JoinUrl) {
		if (!rootUri) throw new Error("A workspace root is required.");
		this.rootUri = rootUri;
		this.#join = join;
		this.#rootSaf = parseSafDocument(rootUri);
	}

	normalize(relativePath: string): string {
		const input = String(relativePath ?? "").trim();
		if (!input || input === ".") return "";
		const decoded = decodeRepeated(input);
		if (decoded === undefined) throw new Error("Path contains invalid percent encoding.");
		validatePathSafety(input);
		validatePathSafety(decoded);
		const stripped = stripWorkspacePrefixes(decoded, this.#rootSaf);
		if (!stripped || stripped === ".") return "";
		validatePathInput(stripped);
		const segments = stripped.split("/").filter((segment) => segment && segment !== ".");
		return segments.join("/");
	}

	resolve(relativePath: string): { relativePath: string; uri: string } {
		const normalized = this.normalize(relativePath);
		return {
			relativePath: normalized,
			uri: normalized ? this.#join(this.rootUri, normalized) : this.rootUri,
		};
	}

	relative(uri: string | undefined | null): string | undefined {
		if (typeof uri !== "string" || !uri) return undefined;
		if (sameWorkspaceUri(uri, this.rootUri)) return "";
		const fromSaf = relativeSafPath(this.#rootSaf, parseSafDocument(uri));
		if (fromSaf !== undefined) return this.#safeNormalize(fromSaf);
		const rootPath = pathWithoutQuery(this.rootUri);
		const uriPath = pathWithoutQuery(uri);
		for (const candidate of [uriPath, uri]) {
			for (const separator of ["/", "::"]) {
				const prefix = `${rootPath.replace(new RegExp(`${separator}+$`), "")}${separator}`;
				if (candidate.startsWith(prefix)) return this.#safeNormalize(candidate.slice(prefix.length));
			}
		}
		return undefined;
	}

	#safeNormalize(value: string): string | undefined {
		try {
			return this.normalize(value);
		} catch {
			return undefined;
		}
	}
}

export function workspaceId(rootUri: string): string {
	let hash = 0xcbf29ce484222325n;
	const safeRoot = stripCredentials(rootUri);
	for (let index = 0; index < safeRoot.length; index += 1) {
		hash ^= BigInt(safeRoot.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(36).padStart(13, "0");
}

/** Turn a native file-index record into a workspace-relative POSIX path. */
export function workspaceRelativeFromIndex(
	entry: { path?: string; url?: string; uri?: string; name?: string },
	sandbox: PathSandbox,
	workspaceName = "",
): string {
	for (const uri of [entry.url, entry.uri]) {
		try {
			const relative = uri ? sandbox.relative(uri) : undefined;
			if (relative !== undefined) return relative;
		} catch {
			// Index URIs can be host-specific; fall through to path / name.
		}
	}
	const raw = String(entry.path ?? "").replace(/^\/+/, "");
	const withoutName = stripWorkspaceName(raw, workspaceName);
	if (raw && workspaceName && (raw === workspaceName || raw.startsWith(`${workspaceName}/`))) {
		if (!withoutName) return "";
		try {
			return sandbox.normalize(withoutName);
		} catch {
			// Index paths can include host-specific prefixes; fall back to the basename.
		}
	}
	if (raw) {
		try {
			return sandbox.normalize(raw);
		} catch {
			// Same fallback as above.
		}
	}
	return entry.name ?? "";
}

export function sameParentUri(parent: string | undefined, expected: string): boolean {
	return sameWorkspaceUri(parent, expected);
}

export function stripCredentials(uri: string): string {
	try {
		const parsed = new URL(uri);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		return parsed.toString();
	} catch {
		return uri.replace(/([?&](?:password|passphrase|keyFile)=[^&]*)/gi, "");
	}
}

type SafDocument = {
	treeUrl: string;
	docId: string;
};

function parseSafDocument(uri: string | undefined | null): SafDocument | undefined {
	if (typeof uri !== "string" || !uri) return undefined;
	const value = uri.split(/[?#]/, 1)[0] ?? "";
	if (!/^content:\/\//i.test(value) || !/\/tree\//i.test(value)) return undefined;
	const separator = value.indexOf("::");
	if (separator >= 0) {
		return {
			treeUrl: trimSlash(value.slice(0, separator)),
			docId: trimSlash(decodeRepeated(value.slice(separator + 2)) ?? value.slice(separator + 2)),
		};
	}
	const treeUrl = trimSlash(value);
	const encodedId = treeUrl.split("/").pop() ?? "";
	return {
		treeUrl,
		docId: trimSlash(decodeRepeated(encodedId) ?? encodedId),
	};
}

function relativeSafPath(root: SafDocument | undefined, uri: SafDocument | undefined): string | undefined {
	if (!root || !uri) return undefined;
	if (canonicalUri(root.treeUrl) !== canonicalUri(uri.treeUrl)) return undefined;
	if (uri.docId === root.docId) return "";
	if (root.docId && uri.docId.startsWith(`${root.docId}/`)) return uri.docId.slice(root.docId.length + 1);
	if (root.docId.endsWith(":") && uri.docId.startsWith(root.docId)) {
		return uri.docId.slice(root.docId.length).replace(/^\/+/, "");
	}
	return undefined;
}

function stripWorkspacePrefixes(path: string, root: SafDocument | undefined): string {
	if (!root?.docId) return path;
	if (path === root.docId) return "";
	if (path.startsWith(`${root.docId}/`)) return path.slice(root.docId.length + 1);
	if (root.docId.endsWith(":") && path.startsWith(root.docId)) {
		return path.slice(root.docId.length).replace(/^\/+/, "");
	}
	return path;
}

function stripWorkspaceName(path: string, workspaceName: string): string {
	if (!path || !workspaceName) return path;
	if (path === workspaceName) return "";
	const prefix = `${workspaceName}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function sameWorkspaceUri(left: string | undefined | null, right: string | undefined | null): boolean {
	const firstPath = pathWithoutQuery(left ?? "");
	const secondPath = pathWithoutQuery(right ?? "");
	if (normalizeUri(firstPath) === normalizeUri(secondPath) && normalizeUri(firstPath)) return true;
	const first = parseSafDocument(firstPath);
	const second = parseSafDocument(secondPath);
	if (!first || !second) return false;
	return canonicalUri(first.treeUrl) === canonicalUri(second.treeUrl) && first.docId === second.docId;
}

function pathWithoutQuery(uri: string): string {
	return uri.split(/[?#]/, 1)[0] ?? uri;
}

function normalizeUri(uri: string | undefined | null): string {
	return trimSlash(uri ?? "");
}

function canonicalUri(uri: string): string {
	return trimSlash(decodeRepeated(uri) ?? uri);
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function decodeRepeated(value: string): string | undefined {
	let decoded = value;
	try {
		for (let pass = 0; pass < 3; pass += 1) {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return decoded;
			decoded = next;
		}
		return decoded;
	} catch {
		return undefined;
	}
}

function validatePathSafety(value: string): void {
	if (value.includes("\0")) throw new Error("Path contains a null byte.");
	if (value.includes("\\")) throw new Error("Use workspace-relative POSIX paths.");
	if (value.includes("?") || value.includes("#")) throw new Error("URI query and fragment delimiters are not allowed in tool paths.");
	const segments = value.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "..")) {
		throw new Error("Parent path segments are not allowed.");
	}
}

function validatePathInput(value: string): void {
	validatePathSafety(value);
	if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("/")) {
		throw new Error("Absolute paths and URI schemes are not allowed.");
	}
}
