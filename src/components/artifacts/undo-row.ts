// Pure row-shaping helpers for the §VI undo surfaces, shared by the admin Undo
// browser (`undo-mode.tsx`, the cross-workspace list) and the non-admin
// targeted restore (`targeted-restore-mode.tsx`, one addressed change-set).
// Extracted verbatim from undo-mode.tsx so both render an identical change-set
// row without duplicating the operation-to-description and title composition.

import { diffSnapshotFields, type ObjectChangeEvent } from "@/lib/object-history";

export type UndoDiffLine = {
  objectId: string;
  objectType: string;
  description: string;
  operation: string;
};

/** Human-facing per-event summary line (create/delete/restore/updated fields). */
export function describeUndoEvent(event: ObjectChangeEvent): string {
  return event.operation === "create"
    ? `created ${event.objectId.slice(0, 8)}…`
    : event.operation === "soft-delete" || event.operation === "tombstone"
      ? `deleted ${event.objectId.slice(0, 8)}…`
      : event.operation === "restore"
        ? `restored ${event.objectId.slice(0, 8)}…`
        : `updated fields: ${
            diffSnapshotFields(event.beforeSnapshot, event.afterSnapshot).join(", ") ||
            "(no diff captured)"
          }`;
}

/** Map a change-set's events to the per-object diff lines a row renders. */
export function buildUndoDiffLines(
  events: readonly ObjectChangeEvent[],
): UndoDiffLine[] {
  return events.map((event) => ({
    objectId: event.objectId,
    objectType: event.objectType,
    description: describeUndoEvent(event),
    operation: event.operation,
  }));
}

/** Compose the row's title line from the affected operations + object count. */
export function composeUndoTitle(
  diffLines: ReadonlyArray<{ operation: string }>,
  count: number,
): string {
  const ops = new Set(diffLines.map((d) => d.operation));
  const noun = `${count} object${count === 1 ? "" : "s"}`;
  if (ops.size === 1) {
    const op = [...ops][0];
    if (op === "soft-delete" || op === "tombstone") return `Deleted ${noun}`;
    if (op === "create") return `Created ${noun}`;
    if (op === "restore") return `Restored ${noun}`;
    if (op === "update") return `Updated ${noun}`;
  }
  return `Changed ${noun}`;
}
