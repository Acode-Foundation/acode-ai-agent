import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";

export type OutputBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Default token budget for a script's output; `// @options: {"max_output_tokens": N}` overrides it. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

/** Characters per token when estimating. */
const CHARS_PER_TOKEN = 4;

/** Like the script's `text()`: strings as is, other values as compact JSON. */
export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Lay out the script's output so the model can tell items apart. With more than one text item,
 * each starts with a `==> text N/M <==` line; `console.*` lines follow everything else in one
 * `<console_output>` block.
 */
export function formatOutput(output: readonly CodemodeOutputItem[]): OutputBlock[] {
  const total = output.filter((item) => item.type === "text" && !item.console).length;
  const items: OutputBlock[] = [];
  const consoleLines: string[] = [];
  let index = 0;
  for (const item of output) {
    if (item.type === "image") {
      items.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item.console) {
      consoleLines.push(item.text);
    } else {
      index += 1;
      items.push({
        type: "text",
        text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text,
      });
    }
  }
  if (consoleLines.length)
    items.push({
      type: "text",
      text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>`,
    });
  return items;
}

/** Join adjacent text items into one, each part starting on its own line. */
export function joinAdjacentText(items: readonly OutputBlock[]): OutputBlock[] {
  const joined: OutputBlock[] = [];
  for (const item of items) {
    const last = joined.at(-1);
    if (item.type === "text" && last?.type === "text") {
      const separator = last.text === "" || last.text.endsWith("\n") ? "" : "\n";
      joined[joined.length - 1] = { type: "text", text: `${last.text}${separator}${item.text}` };
    } else {
      joined.push(item);
    }
  }
  return joined;
}

/**
 * Keep the text within the token budget: past it, the text items become one item with the start
 * and end of the text, followed by the images. There is no file to spill to, so the note tells
 * the model to narrow the script's output instead.
 */
export function truncateOutput(items: readonly OutputBlock[], maxTokens: number): OutputBlock[] {
  const texts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
  const combined = texts.join("\n");
  const budget = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
  if (!texts.length || combined.length <= budget) return [...items];
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - headChars - tailChars;
  const head = combined.slice(0, headChars);
  const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
  const text =
    `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\n` +
    `Total output lines: ${combined.split("\n").length}\n\n` +
    `${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}\n\n` +
    "[Filter or summarize inside the script to see the part you need.]";
  return [{ type: "text", text }, ...items.filter((item) => item.type === "image")];
}
