const FILE_ERROR_MESSAGES: Record<number, string> = {
  1: "Path not found",
  2: "Security error",
  3: "Action aborted",
  4: "File not readable",
  5: "File encoding error",
  6: "Modification not allowed",
  7: "Invalid state",
  8: "Syntax error",
  9: "Invalid modification",
  10: "Quota exceeded",
  11: "Type mismatch",
  12: "Path already exists",
};

/**
 * Readable text for anything Acode or Cordova rejects with: Errors, strings, Cordova
 * `FileError` objects (`{ code }`), FileReader progress events and plain JSON payloads.
 */
export function describeError(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    return (
      error.message ||
      (depth < 2 && error.cause ? describeError(error.cause, depth + 1) : error.name)
    );
  }
  if (typeof error === "string") return error.trim() || "Unknown error";
  if (error === null || error === undefined) return "Unknown error";
  if (typeof error !== "object") return String(error);

  const record = error as Record<string, unknown>;
  const code =
    typeof record.code === "number" || typeof record.code === "string" ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (message) return message;

  if (depth < 2) {
    const nested = record.error ?? (record.target as { error?: unknown } | undefined)?.error;
    if (nested) return describeError(nested, depth + 1);
  }
  if (code !== undefined) return FILE_ERROR_MESSAGES[Number(code)] ?? `Error code ${code}`;

  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // Circular payloads fall through to String().
  }
  const text = String(error);
  return text === "[object Object]" ? "Unknown error" : text;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Wrap a filesystem failure with the operation, path and a recovery hint the model can act on. */
export function fileOperationError(action: string, path: string, error: unknown): Error {
  if (isAbortError(error)) return error as Error;
  const reason = describeError(error);
  const hint = /not found|no such file|does not exist|ENOENT/i.test(reason)
    ? " Check the path with list_dir or glob."
    : "";
  const period = /[.!?]$/.test(reason) ? "" : ".";
  return new Error(`Cannot ${action} ${path || "the workspace root"}: ${reason}${period}${hint}`);
}
