/** Acode's own binary check, when available. */
export function isBinaryPath(path: string): boolean {
  try {
    const helpers = acode.require("helpers") as Acode.Helpers | undefined;
    return helpers?.isBinary?.(path) === true;
  } catch {
    return false;
  }
}

/** Reject binary content and files above Acode's configured size limit. */
export function assertTextFile(path: string, content: string): void {
  if (isBinaryPath(path) || content.includes("\0"))
    throw new Error(`${path} appears to be binary.`);
  if (content.length > maxTextCharacters())
    throw new Error(`${path} exceeds Acode's configured file-size limit.`);
}

function maxTextCharacters(): number {
  try {
    const settings = acode.require("settings") as Acode.Settings;
    return Math.max(1, settings.value.maxFileSize) * 1024 * 1024;
  } catch {
    return 12 * 1024 * 1024;
  }
}

export function detectSupportedImageMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff]) && bytes[3] !== 0xf7) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (asciiAt(bytes, 0, "BM") && bytes.length >= 26) return "image/bmp";
  return undefined;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return (
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}
