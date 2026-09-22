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
  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Local and internal hosts are blocked.");
  }
  if (isPrivateHost(host)) throw new Error("Private network addresses are blocked.");
  return url;
}

export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower.includes(":")) {
    // IPv6 literal.
    if (lower === "::1" || lower === "::") return true;
    // IPv4-mapped (::ffff:192.168.0.1) and IPv4-compatible (::192.168.0.1)
    // forms hide an IPv4 address: judge the embedded address instead. The
    // URL parser normalizes dotted tails to hex (::ffff:a00:5), so handle
    // both spellings.
    const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return isPrivateHost(dotted[1]);
    // ::ffff:0:0/96 (mapped) and ::/96 (compatible, deprecated but parseable):
    // the last 32 bits are an IPv4 address.
    const last32 =
      lower.match(/^::ffff:(?:[0-9a-f]{1,4}:)*([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ??
      lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (last32) {
      const hi = parseInt(last32[1], 16);
      const lo = parseInt(last32[2], 16);
      return isPrivateHost(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    const first = lower.split(":", 1)[0];
    if (!first) return false; // "::..." remainder is global unicast
    if (/^(fc|fd)/.test(first)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(first)) return true; // link-local fe80::/10
    return false;
  }
  // Only dotted quads are IPv4; anything else is a reg-name and cannot be a
  // private address. This avoids blocking public hosts that merely start
  // with "fc"/"fd" (fcm.googleapis.com, fdroid.org) or with digits
  // ("10.example.com").
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return false;
  return PRIVATE_V4.some((pattern) => pattern.test(lower));
}

export function rewriteGithubBlob(url: URL): string {
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return url.toString();
  const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  if (!match) return url.toString();
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
}
