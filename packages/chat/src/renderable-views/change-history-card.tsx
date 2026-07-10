// ---------------------------------------------------------------------------
// change_history renderer (cinatra#1220, S4).
//
// Renders the applied-change / undo-history family (successor to `/chat`'s
// `UndoActionChip` list) as a first-class renderable. The `undoable` flag is
// shown as a badge; wiring an undo action to an authoritative reversing write
// is the deferred surface apply-capability (#1214 / #1037 P4.1), so this slice
// is DISPLAY-ONLY (no live undo button).
// ---------------------------------------------------------------------------

import type { ChangeHistoryView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

export function ChangeHistoryCard({ view }: { view: ChangeHistoryView }) {
  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface p-3"
      data-view-type="change_history"
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Change history
      </div>
      <ul className="flex flex-col gap-1.5">
        {view.entries.map((e, i) => (
          <li
            key={`${e.runId}-${i}`}
            className="flex items-center justify-between gap-2 text-sm"
            data-run-id={e.runId}
          >
            <span className="truncate text-foreground">{e.label}</span>
            {e.undoable && (
              <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-badge-2xs uppercase tracking-wide text-muted-foreground">
                undoable
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
