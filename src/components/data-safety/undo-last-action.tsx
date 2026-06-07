import "server-only";

import {
  loadChangeSet,
  summarizeChangeSetEligibility,
  diffSnapshotFields,
  type LoadedChangeSet,
} from "@/lib/object-history";
import {
  filterEventsForReadAccess,
  findLatestUndoableChangeSetForObject,
  UNDO_WINDOW_MINUTES,
} from "@/lib/object-history/server-views";
import type { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RestoreModal } from "@/components/data-safety/restore-modal";
import { restoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";

// Per-page undo affordance.
//
// Inline "undo your last change to this object" surfaced inside the object
// detail History tab. Scoped to the CURRENT actor's most-recent CLOSED,
// restorable change-set touching THIS object within the freshness window
// (`UNDO_WINDOW_MINUTES`). Renders nothing when there's no such change-set,
// so the affordance only appears when an undo genuinely makes sense.
//
// Reuses the existing `<RestoreModal>` + `restoreChangeSetAction` path verbatim
// (no new restore-engine code) — this component is pure server-side plumbing
// over the existing substrate.

type ActorEnvelope = Parameters<typeof enforceResourceAccess>[1];
type RoleHints = Parameters<typeof enforceResourceAccess>[3];

export type UndoLastActionProps = {
  objectId: string;
  orgId: string | null;
  actorId: string;
  /** Full actor context for per-event read redaction (mirrors detail page). */
  actor: ActorEnvelope;
  roleHints?: RoleHints;
};

export async function UndoLastAction(props: UndoLastActionProps) {
  const openedAfter = new Date(
    Date.now() - UNDO_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const latest = findLatestUndoableChangeSetForObject({
    orgId: props.orgId,
    objectId: props.objectId,
    actorId: props.actorId,
    openedAfter,
  });
  if (!latest) return null;

  const loaded = loadChangeSet(latest.changeSetId, { orgId: props.orgId });
  if (!loaded) return null;

  // Per-event read redaction — same boundary as the change-set detail page.
  const filteredEvents = await filterEventsForReadAccess(
    loaded.events,
    props.actor,
    props.roleHints,
  );
  const view: LoadedChangeSet = {
    changeSet: loaded.changeSet,
    events: filteredEvents,
  };
  const eligibility = summarizeChangeSetEligibility(view);
  const diffLines = view.events.map((event) => {
    const fields = diffSnapshotFields(event.beforeSnapshot, event.afterSnapshot);
    return {
      objectId: event.objectId,
      objectType: event.objectType,
      description:
        event.operation === "create"
          ? `created ${event.objectId.slice(0, 8)}…`
          : event.operation === "soft-delete" || event.operation === "tombstone"
            ? `deleted ${event.objectId.slice(0, 8)}…`
            : event.operation === "restore"
              ? `restored ${event.objectId.slice(0, 8)}…`
              : `updated fields: ${fields.length > 0 ? fields.join(", ") : "(no diff captured)"}`,
    };
  });

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle className="text-sm">Undo your last change</CardTitle>
        <p className="text-xs text-muted-foreground">
          You changed this object in the last {UNDO_WINDOW_MINUTES} minutes. Undo
          appends a new change-set that reverts it — the original is preserved.
        </p>
      </CardHeader>
      <CardContent>
        <RestoreModal
          changeSetId={latest.changeSetId}
          restorable={loaded.changeSet.restorable && eligibility.eligible}
          restorableReason={
            !eligibility.eligible
              ? eligibility.details.join("; ")
              : (loaded.changeSet.restorableReason ?? null)
          }
          affectedObjectCount={new Set(view.events.map((e) => e.objectId)).size}
          diffLines={diffLines}
          action={restoreChangeSetAction}
        />
      </CardContent>
    </Card>
  );
}
