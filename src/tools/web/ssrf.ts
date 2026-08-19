const BLOCKED_HOSTS = new Set([
	"localhost",
	"localhost.localdomain",
	"0.0.0.0",
	"::1",
	"::",
	"metadata.google.internal",
	"metadata.goog",
]);

const PRIVATE_V4 = [
	/^0\./,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[0-1])\./,
	/^192\.168\./,
	/^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
];

export function assertPublicHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Enter a valid http(s) URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Only http(s) URLs can be fetched.");
	}
	if (url.username || url.password) throw new Error("URLs with credentials are blocked.");
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!host) throw new Error("URL is missing a hostname.");
	if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		throw new Error("Local and internal hosts are blocked.");
	}
	if (isPrivateHost(host)) throw new Error("Private network addresses are blocked.");
	return url;
}

export function isPrivateHost(host: string): boolean {
	if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
		return true;
	}
	if (host.includes(":")) return false;
	return PRIVATE_V4.some((pattern) => pattern.test(host));
}

export function rewriteGithubBlob(url: URL): string {
	if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return url.toString();
	const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
	if (!match) return url.toString();
	return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
}
