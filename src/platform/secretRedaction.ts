import { err, FileError, type FileSystem } from "@earendil-works/pi-durable/env";

/** Best-effort redaction of provider keys and bearer tokens in persisted chat records. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(or-[A-Za-z0-9_-]{12,})\b/gi, "[REDACTED_API_KEY]")
    .replace(/\b(gsk_[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(xai-[A-Za-z0-9_-]{12,})\b/gi, "[REDACTED_API_KEY]")
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]");
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Image payloads are base64, never secrets; leave them byte-identical.
    if (record.type === "image" && typeof record.data === "string") return record;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, redactDeep(item)]));
  }
  return value;
}

/** Redact each complete JSON line; the line structure Pi's JSONL storage relies on is kept. */
export function redactJsonl(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? JSON.stringify(redactDeep(JSON.parse(line))) : line))
    .join("\n");
}

/** Wrap the file system Pi's JSONL storage writes through, redacting what reaches disk. */
export function redactingFileSystem(fileSystem: FileSystem): FileSystem {
  return new Proxy(fileSystem, {
    get(target, property) {
      if (property === "writeFile" || property === "appendFile") {
        const method = target[property].bind(target);
        const write: FileSystem["writeFile"] = async (path, content, context) => {
          try {
            const text = typeof content === "string" ? content : new TextDecoder().decode(content);
            return await method(
              path,
              /\.jsonl(?:\.reclaim)?$/.test(path) ? redactJsonl(text) : content,
              context,
            );
          } catch (error) {
            return err(
              new FileError(
                "unknown",
                error instanceof Error ? error.message : String(error),
                path,
              ),
            );
          }
        };
        return write;
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
