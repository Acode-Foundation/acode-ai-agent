import { err, FileError, type FileSystem } from "@earendil-works/pi-agent-core";
/** Preserve the existing best-effort secret redaction at the persistence boundary. */
function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(or-[A-Za-z0-9_-]{12,})\b/gi, "[REDACTED_API_KEY]")
    .replace(/\b(gsk_[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(xai-[A-Za-z0-9_-]{12,})\b/gi, "[REDACTED_API_KEY]")
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]");
}

function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      return {
        ...record,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/jpeg",
        data: record.data,
      } as T;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        /(?:api.?key|authorization|access.?token|refresh.?token|password|passphrase|secret|credential)/i.test(
          key,
        )
          ? "[REDACTED_SECRET]"
          : redactDeep(item),
      ]),
    ) as T;
  }
  return value;
}

export function redactSessionJsonl(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? JSON.stringify(redactDeep(JSON.parse(line))) : line))
    .join("\n");
}

/** Redact only persisted JSONL, leaving Pi's live in-memory request untouched. */
export function redactedSessionFileSystem(fileSystem: FileSystem): FileSystem {
  return new Proxy(fileSystem, {
    get(target, property) {
      if (property === "writeFile" || property === "appendFile") {
        const method = target[property].bind(target);
        const write: FileSystem["writeFile"] = async (path, content, context) => {
          try {
            const next = /\.jsonl(?:\.tmp)?$/.test(path)
              ? redactSessionJsonl(
                  typeof content === "string" ? content : new TextDecoder().decode(content),
                )
              : content;
            return await method(path, next, context);
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
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
