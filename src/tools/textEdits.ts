export type EditPair = { oldText: string; newText: string };

/**
 * The replacements in an `edit_file` call: Pi's `edits: [{ oldText, newText }]`, a single
 * `oldText`/`newText`, or the earlier `old_string`/`new_string` arguments stored in older sessions.
 */
export function editPairs(args: Record<string, unknown> | undefined): EditPair[] {
  if (!args) return [];
  const pairs: EditPair[] = [];
  let edits = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  for (const edit of Array.isArray(edits) ? edits : edits ? [edits] : []) {
    const pair = toPair(edit);
    if (pair) pairs.push(pair);
  }
  const single = toPair(args);
  if (single) pairs.push(single);
  return pairs;
}

/**
 * Accept the `old_string`/`new_string` spelling models trained on other agents often use and
 * hand Pi's edit tool its own `edits` shape.
 */
export function legacyEditArguments(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const {
    old_string,
    new_string,
    replace_all: _replaceAll,
    ...rest
  } = args as Record<string, unknown>;
  if (typeof old_string !== "string" || typeof new_string !== "string") return args;
  const edits = Array.isArray(rest.edits) ? [...rest.edits] : [];
  edits.push({ oldText: old_string, newText: new_string });
  return { ...rest, edits };
}

function toPair(value: unknown): EditPair | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const oldText = record.oldText ?? record.old_string;
  const newText = record.newText ?? record.new_string;
  return typeof oldText === "string" && typeof newText === "string"
    ? { oldText, newText }
    : undefined;
}
