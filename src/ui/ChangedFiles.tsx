import { ChevronRight, Undo2 } from "lucide-preact";
import { useState } from "preact/hooks";
import type { RunEditFile, RunEditSummary, WorkspaceInfo } from "../core/types";
import { openWorkspaceFile } from "../platform/editorNavigation";
import { Collapse, RotateIcon } from "./Collapse";
import { fileIconClass } from "./fileGlyph";

const COLLAPSED_ROWS = 5;

/**
 * The files one turn changed: a count with line totals, an Undo, and a row per file with
 * Acode's file icon and its own counts. Tapping a row opens the file in the editor.
 */
export function ChangedFiles({
  summary,
  disabled,
  workspace,
  onUndo,
}: {
  summary: RunEditSummary;
  disabled: boolean;
  workspace?: WorkspaceInfo;
  onUndo: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const count = summary.files.length;
  const rows = showAll ? summary.files : summary.files.slice(0, COLLAPSED_ROWS);
  if (summary.reverted) return <UndoneChanges summary={summary} workspace={workspace} />;
  return (
    <section class="changes" aria-label="Changed files">
      <header class="changes-head">
        <span class="changes-title">
          {count} changed file{count === 1 ? "" : "s"}
        </span>
        <LineCounts added={summary.added} removed={summary.removed} />
        <button type="button" class="changes-action" disabled={disabled} onClick={onUndo}>
          <Undo2 size={14} strokeWidth={2} aria-hidden="true" />
          Undo
        </button>
      </header>
      <ul class="changes-files">
        {rows.map((file) => (
          <ChangedFileRow
            key={file.path}
            file={file}
            undone={summary.reverted}
            workspace={workspace}
          />
        ))}
      </ul>
      {count > COLLAPSED_ROWS && (
        <button type="button" class="changes-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show fewer" : `Show ${count - COLLAPSED_ROWS} more`}
        </button>
      )}
    </section>
  );
}

/** After Undo the turn's changes are reverted: one muted line, with the files on tap. */
function UndoneChanges({
  summary,
  workspace,
}: {
  summary: RunEditSummary;
  workspace?: WorkspaceInfo;
}) {
  const [open, setOpen] = useState(false);
  const count = summary.files.length;
  return (
    <section class="changes-undone" aria-label="Reverted changes">
      <button
        type="button"
        class="changes-undone-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Undo2 size={13} strokeWidth={2} aria-hidden="true" />
        <span>
          Changes reverted · {count} file{count === 1 ? "" : "s"}
        </span>
        <RotateIcon open={open} class="work-chevron">
          <ChevronRight size={14} strokeWidth={2} />
        </RotateIcon>
      </button>
      <Collapse open={open}>
        <ul class="changes-files undone">
          {summary.files.map((file) => (
            <ChangedFileRow key={file.path} file={file} undone workspace={workspace} />
          ))}
        </ul>
      </Collapse>
    </section>
  );
}

function ChangedFileRow({
  file,
  undone,
  workspace,
}: {
  file: RunEditFile;
  undone: boolean;
  workspace?: WorkspaceInfo;
}) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash > 0 ? file.path.slice(0, slash) : "";
  // A file the turn created is gone after Undo, so there is nothing to open.
  const gone = undone && file.created;
  return (
    <li>
      <button
        type="button"
        class="changes-row"
        disabled={gone}
        title={gone ? undefined : `Open ${file.path}`}
        onClick={() => openWorkspaceFile(file.path, workspace)}
      >
        <span class={`file-glyph ${fileIconClass(name)}`} aria-hidden="true" />
        <span class="changes-name">{name}</span>
        {folder && <span class="changes-folder">{folder}</span>}
        {file.skipped ? (
          <span class="changes-skipped">too large</span>
        ) : (
          <LineCounts added={file.added} removed={file.removed} />
        )}
      </button>
    </li>
  );
}

function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span class="line-counts">
      <span class="line-added">+{added}</span>
      <span class="line-removed">−{removed}</span>
    </span>
  );
}
