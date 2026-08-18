export type JoinUrl = (root: string, path: string) => string;

export class PathSandbox {
	readonly rootUri: string;
	#join: JoinUrl;

	constructor(rootUri: string, join: JoinUrl) {
		if (!rootUri) throw new Error("A workspace root is required.");
		this.rootUri = rootUri;
		this.#join = join;
	}

	normalize(relativePath: string): string {
		const input = String(relativePath ?? "").trim();
		if (!input || input === ".") return "";
		let decoded = input;
		try {
			for (let pass = 0; pass < 3; pass += 1) {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			}
		} catch {
			throw new Error("Path contains invalid percent encoding.");
		}
		validatePathInput(input);
		validatePathInput(decoded);
		const segments = input.split("/").filter((segment) => segment && segment !== ".");
		const normalized = segments.join("/");
		return normalized;
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
		if (uri === this.rootUri) return "";
		for (const separator of ["/", "::"]) {
			const prefix = `${this.rootUri.replace(new RegExp(`${separator}+$`), "")}${separator}`;
			if (uri.startsWith(prefix)) return this.normalize(uri.slice(prefix.length));
		}
		return undefined;
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
		const relative = uri ? sandbox.relative(uri) : undefined;
		if (relative !== undefined) return relative;
	}
	const raw = String(entry.path ?? "").replace(/^\/+/, "");
	if (raw && workspaceName) {
		if (raw === workspaceName) return "";
		const prefix = `${workspaceName}/`;
		if (raw.startsWith(prefix)) return raw.slice(prefix.length);
	}
	if (raw) {
		try {
			return sandbox.normalize(raw);
		} catch {
			// Index paths can include host-specific prefixes; fall back to the basename.
		}
	}
	return entry.name ?? "";
}

export function sameParentUri(parent: string | undefined, expected: string): boolean {
	return normalizeUri(parent) === normalizeUri(expected);
}

function normalizeUri(uri: string | undefined): string {
	return (uri ?? "").replace(/\/+$/, "");
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

function validatePathInput(value: string): void {
	if (value.includes("\0")) throw new Error("Path contains a null byte.");
	if (value.includes("\\")) throw new Error("Use workspace-relative POSIX paths.");
	if (value.includes("?") || value.includes("#")) throw new Error("URI query and fragment delimiters are not allowed in tool paths.");
	if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("/")) {
		throw new Error("Absolute paths and URI schemes are not allowed.");
	}
	const segments = value.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "..")) {
		throw new Error("Parent path segments are not allowed.");
	}
}
