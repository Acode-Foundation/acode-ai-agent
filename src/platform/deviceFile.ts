import { fileName, isImagePath } from "../workspace/fileMentions";
import type { DraftFile, DraftImage } from "../ui/composerDraft";
import { bytesToBase64, imageContentFromBytes } from "./promptImages";

const MAX_FILE_CHARS = 256 * 1024;
const MAX_BINARY_BYTES = 64 * 1024;

/** Converts a file returned by the system media chooser into a draft attachment. */
export async function attachmentFromMediaFile(
  file: File,
  autoResize = true,
): Promise<DraftFile | DraftImage> {
  return attachmentFromBytes(
    new Uint8Array(await file.arrayBuffer()),
    file.name || "file",
    undefined,
    autoResize,
    file.type,
  );
}

export async function pickAcodeFile(
  autoResize = true,
): Promise<DraftFile | DraftImage | undefined> {
  try {
    const browser = acode.require("fileBrowser") as FileBrowser | undefined;
    if (typeof browser !== "function") throw new Error("Acode's file picker is unavailable.");
    const picked = await browser("file", "Choose a file to attach", true);
    if (!picked?.url) return undefined;
    const name = picked.name || fileName(picked.url) || "file";
    const buffer = await acode.fsOperation(picked.url).readFile();
    return attachmentFromBytes(new Uint8Array(buffer), name, picked.url, autoResize);
  } catch (error) {
    if (isCancel(error)) return undefined;
    throw error;
  }
}

async function attachmentFromBytes(
  bytes: Uint8Array,
  name: string,
  uri: string | undefined,
  autoResize: boolean,
  mimeType?: string,
): Promise<DraftFile | DraftImage> {
  if (mimeType?.startsWith("image/") || isImagePath(name)) {
    const image = await imageContentFromBytes(bytes, name, mimeType, autoResize);
    return { ...image, id: newId("img"), name, uri };
  }
  const source = decodeText(bytes);
  const binary = source === undefined;
  const content = binary
    ? bytesToBase64(bytes.subarray(0, MAX_BINARY_BYTES))
    : source.length > MAX_FILE_CHARS
      ? `${source.slice(0, MAX_FILE_CHARS)}\n\n[Attachment truncated.]`
      : source;
  return {
    id: newId("file"),
    name,
    uri,
    content,
    encoding: binary ? "base64" : "text",
    truncated: binary ? bytes.byteLength > MAX_BINARY_BYTES : source.length > MAX_FILE_CHARS,
  };
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, MAX_FILE_CHARS).some((byte) => byte === 0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isCancel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /cancel|cancell?ed|abort/i.test(message);
}

function newId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}
