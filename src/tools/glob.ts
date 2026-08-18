import picomatch from "picomatch";

export function globMatcher(pattern: string): { test: (path: string) => boolean } {
	const normalized = normalizeGlob(pattern);
	const match = picomatch(normalized, {
		nocase: true,
		dot: false,
		posix: true,
		matchBase: !normalized.includes("/"),
	});
	return { test: (path: string) => match(path.replace(/^\/+/, "")) };
}

function normalizeGlob(pattern: string): string {
	const trimmed = pattern.trim().replace(/^\.\//, "") || "*";
	if (!trimmed.includes("/") && !trimmed.startsWith("**")) return `**/${trimmed}`;
	return trimmed;
}
