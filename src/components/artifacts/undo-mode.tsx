import "server-only";
/**
 * §VI Undo — data safety, relocated under the admin side (cinatra#1431, spec
 * design@4c6799db §VI; formerly `/data-safety`). Recent destructive object
 * operations, each a title line over a muted meta line with a right-aligned
 * Undo action; the empty state reads that there is nothing to undo.
 *
 * The detailed operation semantics are unchanged from the existing surface:
 * each Undo reuses the exact `restoreChangeSetAction` path the former change-
 * set detail page used, which independently re-checks per-object authorization
 * on confirm. This is an admin-only mode (server-gated by the surface).
 */
import { formatDistanceToNow } from "date-fns";
import { Undo2 } from "lucide-react";

import {
  listChangeSets,
  loadChangeSet,
  diffSnapshotFields,
} from "@/lib/object-history";
import { RestoreModal } from "@/components/data-safety/restore-modal";
import { restoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";

const UNDO_LIST_LIMIT = 25;

export function UndoMode({ orgId }: { orgId: string | null }) {
  if (!orgId) return <UndoEmptyState />;

  let changeSets: ReturnType<typeof listChangeSets>;
  try {
    changeSets = listChangeSets({ orgId, restorable: true, limit: UNDO_LIST_LIMIT });
  } catch {
    return <UndoErrorState />;
  }

  if (changeSets.length === 0) return <UndoEmptyState />;

  const rows = changeSets.map((cs) => {
    const loaded = loadChangeSet(cs.id, { orgId });
    const events = loaded?.events ?? [];
    const objectIds = new Set(events.map((e) => e.objectId));
    const objectTypes = new Set(events.map((e) => e.objectType));
    const diffLines = events.map((event) => ({
      objectId: event.objectId,
      objectType: event.objectType,
      description:
        event.operation === "create"
          ? `created ${event.objectId.slice(0, 8)}…`
          : event.operation === "soft-delete" || event.operation === "tombstone"
            ? `deleted ${event.objectId.slice(0, 8)}…`
            : event.operation === "restore"
              ? `restored ${event.objectId.slice(0, 8)}…`
              : `updated fields: ${
                  diffSnapshotFields(event.beforeSnapshot, event.afterSnapshot).join(", ") ||
                  "(no diff captured)"
                }`,
      operation: event.operation,
    }));
    return {
      id: cs.id,
      restorable: cs.restorable,
      restorableReason: cs.restorableReason ?? null,
      openedAt: cs.openedAt,
      actorKind: cs.actorKind,
      actorId: cs.actorId,
      objectCount: objectIds.size,
      dominantType: objectTypes.size === 1 ? [...objectTypes][0]! : null,
      title: composeUndoTitle(diffLines, objectIds.size),
      diffLines: diffLines.map(({ objectId, objectType, description }) => ({
        objectId,
        objectType,
        description,
      })),
    };
  });

  return (
    <ul
      className="overflow-hidden rounded-lg border border-line bg-surface-strong"
      data-testid="artifacts-undo"
      data-conformance-id="artifacts-undo"
    >
      {rows.map((r, i) => (
        <li
          key={r.id}
          className={
            "flex items-center gap-3 px-3.5 py-3" +
            (i === rows.length - 1 ? "" : " border-b border-line")
          }
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {r.title}
              {r.dominantType ? (
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  {r.dominantType}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              by {r.actorKind ?? "system"}
              {r.actorId ? ` · ${r.actorId.slice(0, 8)}` : ""}
              {r.openedAt
                ? ` · ${formatDistanceToNow(new Date(r.openedAt), { addSuffix: true })}`
                : ""}
            </p>
          </div>
          <div className="flex-none" data-action="undo -> restored">
            <RestoreModal
              changeSetId={r.id}
              restorable={r.restorable}
              restorableReason={r.restorableReason}
              affectedObjectCount={r.objectCount}
              diffLines={r.diffLines}
              action={restoreChangeSetAction}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function composeUndoTitle(
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

function UndoEmptyState() {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center"
      data-testid="artifacts-undo"
      data-conformance-id="artifacts-undo"
      data-state="empty"
    >
      <Undo2 aria-hidden className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Nothing to undo.</p>
    </div>
  );
}

function UndoErrorState() {
  return (
    <div
      className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
      data-testid="artifacts-undo"
      data-conformance-id="artifacts-undo"
      data-state="error"
    >
      Couldn&apos;t load the undo history.
    </div>
  );
}
