/** Pi's default tool-output budget, shared by the workspace tools Pi does not provide. */
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Keep whole leading lines within the byte budget; report how many survived. */
export function truncateHead(
  text: string,
  maxBytes = DEFAULT_MAX_BYTES,
): { content: string; truncated: boolean; outputLines: number } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes)
    return { content: text, truncated: false, outputLines: text.split("\n").length };
  const kept: string[] = [];
  let bytes = 0;
  for (const line of text.split("\n")) {
    const size = encoder.encode(line).length + (kept.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  return { content: kept.join("\n"), truncated: true, outputLines: kept.length };
}
