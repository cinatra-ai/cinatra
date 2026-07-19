import "server-only";
/**
 * Restore objects tab — the Artifacts console's change-set restore console
 * (cinatra#1786, spec design@923fa0d8 §IV). Every save/edit/delete an agent run
 * or a user makes over objects is captured as a reversible change set; this tab
 * lists them time-keyed across every extension and each row's Undo opens the
 * restore confirmation in place (an inline modal).
 *
 * Reuses the existing undo/restore machinery wholesale — `listChangeSets` /
 * `loadChangeSet` for the list, the shared `undo-row` title/diff helpers, and
 * the `RestoreModal` + `restoreChangeSetAction` confirm path (which
 * independently re-checks per-object authorization on confirm: authorized per
 * object, no administrator bypass). Only the entry chrome (operation · type,
 * "by an agent run · when") is the console's own presentation.
 */
import { formatDistanceToNow } from "date-fns";
import { Undo2 } from "lucide-react";

import { listChangeSets, loadChangeSet } from "@/lib/object-history";
import { RestoreModal } from "@/components/data-safety/restore-modal";
import { restoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";
import { buildUndoDiffLines, composeUndoTitle } from "@/components/artifacts/undo-row";

const RESTORE_LIST_LIMIT = 25;

/** "by an agent run" / "by you" / "by the system", per the change-set actor. */
function byLabel(actorKind: string | null): string {
  if (actorKind === "agent") return "by an agent run";
  if (actorKind === "user") return "by you";
  return "by the system";
}

export async function RestoreObjectsTab({ orgId }: { orgId: string | null }) {
  if (!orgId) return <RestoreEmptyState />;

  let changeSets: ReturnType<typeof listChangeSets>;
  try {
    changeSets = listChangeSets({ orgId, restorable: true, limit: RESTORE_LIST_LIMIT });
  } catch {
    return <RestoreErrorState />;
  }

  if (changeSets.length === 0) return <RestoreEmptyState />;

  const rows = changeSets.map((cs) => {
    const loaded = loadChangeSet(cs.id, { orgId });
    const events = loaded?.events ?? [];
    const objectIds = new Set(events.map((e) => e.objectId));
    const objectTypes = new Set(events.map((e) => e.objectType));
    const diffLines = buildUndoDiffLines(events);
    return {
      id: cs.id,
      restorable: cs.restorable,
      restorableReason: cs.restorableReason ?? null,
      openedAt: cs.openedAt,
      actorKind: cs.actorKind,
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
      data-testid="artifacts-restore-console"
      data-conformance-id="artifacts-restore-console"
    >
      {rows.map((r, i) => (
        <li
          key={r.id}
          data-testid="artifacts-restore-row"
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
                  · {r.dominantType}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {byLabel(r.actorKind)}
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

function RestoreEmptyState() {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center"
      data-testid="artifacts-restore-console"
      data-conformance-id="artifacts-restore-console"
      data-state="empty"
    >
      <Undo2 aria-hidden className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">There is nothing to undo.</p>
    </div>
  );
}

function RestoreErrorState() {
  return (
    <div
      className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
      data-testid="artifacts-restore-console"
      data-conformance-id="artifacts-restore-console"
      data-state="error"
    >
      Couldn&apos;t load the restore history.
    </div>
  );
}
