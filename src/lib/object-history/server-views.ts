// Server-side history view helpers.
//
// The change-set detail UI route loads every event in the change_set after
// only an org-scoped check, which would leak metadata for objects the user
// lacks `object.read` on. This module extracts the same partial-visibility
// safety the MCP `change_set_get` handler uses, so server-rendered routes
// can apply the same redaction.
//
// Redaction policy mirrors the MCP path: events on inaccessible objects
// are returned with snapshots + actor/run/audit refs scrubbed; the
// object id / type / sequence / timestamps remain so the timeline shape
// is preserved.

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  readObjectScopeById,
  type ObjectChangeEvent,
} from "@/lib/object-history";
import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

// Accept the full ActorContext rather than a synthesised envelope, so
// enforceResourceAccess can read the resolved orgRole / teamIds /
// projectGrants the RBAC kernel needs to grant org-owned access.
type ActorEnvelope = Parameters<typeof enforceResourceAccess>[1];

function redact(event: ObjectChangeEvent): ObjectChangeEvent {
  return {
    ...event,
    beforeSnapshot: null,
    afterSnapshot: null,
    actorId: null,
    runId: null,
    auditEventId: null,
    remoteRevisionRef: null,
  };
}

/**
 * Per-event read-access partition. Returns each event paired with whether the
 * actor can read it: `canRead: true` carries the full event; `canRead: false`
 * carries the REDACTED event (snapshots + actor/run/audit refs scrubbed, shape
 * preserved). The per-event verdict lets the change-set detail page OMIT
 * deep-links to objects the actor can't read (not render them as broken
 * links).
 */
export async function partitionEventsByReadAccess(
  events: readonly ObjectChangeEvent[],
  actor: ActorEnvelope,
  roleHints?: Parameters<typeof enforceResourceAccess>[3],
): Promise<Array<{ event: ObjectChangeEvent; canRead: boolean }>> {
  const out: Array<{ event: ObjectChangeEvent; canRead: boolean }> = [];
  const orgId =
    (actor as unknown as { organizationId?: string | null; orgId?: string | null })
      .organizationId ??
    (actor as unknown as { orgId?: string | null }).orgId ??
    null;
  for (const event of events) {
    let identity: ResourceForAccessCheck = {
      resourceType: "object",
      resourceId: event.objectId,
      organizationId: event.orgId,
      ownerLevel: normalizeOwnerLevel(event.ownerLevel ?? "organization"),
      ownerId: event.ownerId ?? "",
      visibility:
        (event.visibility as "private" | "team" | "organization" | "public") ??
        "organization",
    };
    if (!event.afterSnapshot) {
      const current = readObjectScopeById(event.objectId, { orgId });
      if (current) {
        identity = {
          resourceType: "object",
          resourceId: current.id,
          organizationId: current.orgId,
          ownerLevel: normalizeOwnerLevel(current.ownerLevel ?? "organization"),
          ownerId: current.ownerId ?? "",
          visibility:
            (current.visibility as "private" | "team" | "organization" | "public") ??
            "organization",
        };
      }
    }
    try {
      await enforceResourceAccess(identity, actor, "object.read", roleHints);
      out.push({ event, canRead: true });
    } catch (e) {
      if (e instanceof AuthzError) {
        out.push({ event: redact(event), canRead: false });
      } else {
        throw e;
      }
    }
  }
  return out;
}

export async function filterEventsForReadAccess(
  events: readonly ObjectChangeEvent[],
  actor: ActorEnvelope,
  roleHints?: Parameters<typeof enforceResourceAccess>[3],
): Promise<ObjectChangeEvent[]> {
  return (await partitionEventsByReadAccess(events, actor, roleHints)).map(
    (p) => p.event,
  );
}

// ---------------------------------------------------------------------------
// Per-event RESTORE (write) authz — the inverse-operation enforcement loop a
// change-set undo performs on every affected event. Shared by
// restoreChangeSetAction (throw-on-deny) and the deep-link auto-open gate
// (boolean) so "actor passes per-event authz before the modal auto-opens" is
// enforced by the SAME logic the confirm path runs — never a modal that
// auto-opens but whose confirm is denied.
// ---------------------------------------------------------------------------
export async function assertChangeSetRestoreAccess(
  events: readonly ObjectChangeEvent[],
  actor: ActorEnvelope,
  roleHints?: Parameters<typeof enforceResourceAccess>[3],
): Promise<void> {
  for (const event of events) {
    // The undo of an operation requires the INVERSE write permission:
    // create→delete, (soft-)delete/tombstone→create, otherwise update.
    const mode =
      event.operation === "create"
        ? "object.delete"
        : event.operation === "soft-delete" || event.operation === "tombstone"
          ? "object.create"
          : "object.update";
    await enforceResourceAccess(
      {
        resourceType: "object",
        resourceId: event.objectId,
        organizationId: event.orgId,
        ownerLevel: normalizeOwnerLevel(event.ownerLevel ?? "organization"),
        ownerId: event.ownerId ?? "",
        visibility:
          (event.visibility as "private" | "team" | "organization" | "public") ??
          "organization",
      },
      actor,
      mode,
      roleHints,
    );
  }
}

export async function canActorRestoreChangeSet(
  events: readonly ObjectChangeEvent[],
  actor: ActorEnvelope,
  roleHints?: Parameters<typeof enforceResourceAccess>[3],
): Promise<boolean> {
  try {
    await assertChangeSetRestoreAccess(events, actor, roleHints);
    return true;
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Per-page undo affordance.
//
// `<UndoLastAction>` needs to answer "did the CURRENT actor just change THIS
// object, recently enough that an inline undo makes sense?". This is NOT the
// MCP `change_set_list` surface (that one is org-wide). It is a narrow
// server-only lookup constrained by actor + object + freshness window +
// closed-and-restorable, so the undo button never offers "latest change by
// anyone" or an in-flight change-set.
// ---------------------------------------------------------------------------

/**
 * Freshness window for the inline per-object undo affordance. A change-set
 * opened more than this many minutes ago is no longer offered as a one-click
 * "undo your last action" — the user should use the full History tab /
 * change-set console instead. Server-side constant (not caller-supplied) so
 * the bound can't be widened from the client.
 */
export const UNDO_WINDOW_MINUTES = 5;

export type LatestUndoableChangeSet = {
  changeSetId: string;
  restorable: boolean;
};

/**
 * Find the current actor's most-recent CLOSED, restorable change-set that
 * touched a specific object within the freshness window. Single SQL join
 * `change_set` ⋈ `object_change_event` (so we constrain by the affected
 * object), filtered by:
 *   - `cs.org_id = $orgId`         (cross-tenant safety)
 *   - `cs.actor_id = $actorId`     (NOT "latest by anyone")
 *   - `cs.opened_at > $openedAfter`(freshness window)
 *   - `cs.closed_at IS NOT NULL`   (open/in-flight change-sets are not undoable)
 *   - `oce.object_id = $objectId`  (this object only)
 *   - `cs.restorable = true`       (stored restorability gate)
 * Ordered newest-first, `LIMIT 1`. Returns null when no row matches.
 *
 * `openedAfter` is an ISO timestamp; the caller computes it from
 * `UNDO_WINDOW_MINUTES` (kept as a parameter so tests can pin the boundary).
 */
export function findLatestUndoableChangeSetForObject(input: {
  orgId: string | null;
  objectId: string;
  actorId: string;
  openedAfter: string;
}): LatestUndoableChangeSet | null {
  // An orgless caller can never own a scoped undo — fail closed.
  if (input.orgId == null) return null;
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        // DISTINCT because the join to object_change_event multiplies rows
        // when a change-set has several events on the same object. opened_at
        // is in the SELECT list so the DISTINCT ORDER BY is legal.
        // `cs.actor_kind = 'user'` is load-bearing for the actor-scope
        // invariant, not cosmetic. The legacy writer
        // stamps `actor_kind = 'system'` while carrying the object's ORIGINAL
        // creator id as `actor_id` (objects-store.ts legacyActorId =
        // existing.createdBy). Without this clause, user A could be offered an
        // inline undo for a change user B actually made via the legacy path on
        // an object A created — A's id is on the row, but A is not the mutator.
        // Failing closed to canonical UI-user change-sets prevents that.
        text: `SELECT DISTINCT cs.id, cs.opened_at, cs.restorable
               FROM "${schema}"."change_set" cs
               JOIN "${schema}"."object_change_event" oce
                 ON oce.change_set_id = cs.id
               WHERE cs.org_id = $1
                 AND cs.actor_id = $2
                 AND cs.actor_kind = 'user'
                 AND cs.opened_at > $3::timestamptz
                 AND cs.closed_at IS NOT NULL
                 AND oce.object_id = $4
                 AND cs.restorable = true
               ORDER BY cs.opened_at DESC, cs.id DESC
               LIMIT 1`,
        values: [input.orgId, input.actorId, input.openedAfter, input.objectId],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) return null;
  return {
    changeSetId: String(row.id),
    restorable: row.restorable === true,
  };
}
