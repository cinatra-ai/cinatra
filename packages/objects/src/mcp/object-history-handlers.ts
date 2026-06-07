// Data Safety: Undo & Versioning — MCP primitives.
//
// Surfaces: change_set_undo, object_version_restore, change_set_get,
// change_set_list, object_history_list, change_set_eligibility_get.
//
// Authz boundary: history reads are filtered by the RBAC kernel; a
// change_set whose affected objects are not all readable by the current
// actor returns the redacted partial shape. Restore requires
// `object.update / create / delete` authority on EVERY affected object —
// current-actor evaluated, not original actor.

import {
  loadChangeSet,
  listChangeSets,
  listEventsForObject,
  readObjectScopeById,
  resolveExternalFreshness,
  freshnessCheckForChangeSet,
  listRemoteEffectAttemptsForChangeSet,
  retryRemoteEffect,
  summarizeChangeSetEligibility,
  restoreChangeSet,
  restoreObjectToVersion,
  type LoadedChangeSet,
  type ObjectChangeEvent,
  type HistoryActor,
  type ObjectScopeSnapshot,
} from "@/lib/object-history";
import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import * as schemas from "./schemas";

// Casting helper to read the org/user fields stamped onto the actor by the
// MCP transport. Mirrors the pattern used elsewhere in handlers.ts.
type ActorExt = {
  orgId: string | null;
  userId: string | null;
  agentId?: string | null;
  runId?: string | null;
  source?: string | null;
};
function getActorExt(actor: unknown): ActorExt {
  const a = actor as Record<string, unknown>;
  return {
    orgId: (a?.orgId as string | undefined) ?? null,
    userId: (a?.userId as string | undefined) ?? null,
    agentId: (a?.agentId as string | undefined) ?? null,
    runId: (a?.runId as string | undefined) ?? null,
    source: (a?.source as string | undefined) ?? null,
  };
}

function buildObjectResourceCheck(row: ObjectScopeSnapshot): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: row.id,
    organizationId: row.orgId ?? null,
    ownerLevel: normalizeOwnerLevel(row.ownerLevel ?? "organization"),
    ownerId: row.ownerId ?? "",
    visibility:
      (row.visibility as ResourceForAccessCheck["visibility"]) ?? "organization",
  };
}

function actorFromRequest(
  request: PrimitiveInvocationRequest<unknown>,
): HistoryActor {
  const ext = getActorExt(request.actor);
  const actorKind: HistoryActor["actorKind"] = ext.agentId
    ? "agent"
    : ext.userId
      ? "user"
      : "system";
  return {
    actorId: ext.userId ?? ext.agentId ?? null,
    actorKind,
    orgId: ext.orgId,
    runId: ext.runId ?? null,
  };
}

function redactInaccessibleEvent(
  event: ObjectChangeEvent,
): ObjectChangeEvent {
  // For history reads where the actor cannot read a particular object,
  // we return a minimal redacted shape: keep change_set membership +
  // object metadata, drop snapshots + provenance fields that could leak
  // PII or scope.
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

// Explicit per-event read verdict. The attempts list must filter by the AUTHZ
// verdict, not by snapshot survival (snapshot-survival is the redaction shape,
// not the read decision, and can drift). filterEventsForReadAccess delegates
// to this so both the redacted view and the canRead verdict come from one
// authz loop.
async function partitionEventsForReadAccess(
  events: ObjectChangeEvent[],
  request: PrimitiveInvocationRequest<unknown>,
): Promise<Array<{ event: ObjectChangeEvent; canRead: boolean }>> {
  const ext = getActorExt(request.actor);
  const orgId = ext.orgId ?? null;
  const out: Array<{ event: ObjectChangeEvent; canRead: boolean }> = [];
  for (const event of events) {
    // Use the after-snapshot identity to evaluate. Falls back to current
    // row if the after snapshot is absent (e.g. delete events).
    let identity: ResourceForAccessCheck = {
      resourceType: "object",
      resourceId: event.objectId,
      organizationId: event.orgId,
      ownerLevel: normalizeOwnerLevel(event.ownerLevel ?? "organization"),
      ownerId: event.ownerId ?? "",
      visibility:
        (event.visibility as ResourceForAccessCheck["visibility"]) ??
        "organization",
    };
    if (!event.afterSnapshot) {
      const current = readObjectScopeById(event.objectId, { orgId });
      if (current) {
        identity = buildObjectResourceCheck(current);
      }
    }
    try {
      await enforceResourceAccess(identity, request.actor, "object.read");
      out.push({ event, canRead: true });
    } catch (e) {
      if (e instanceof AuthzError) {
        // Partial-visibility — surface a redacted shape.
        out.push({ event: redactInaccessibleEvent(event), canRead: false });
      } else {
        throw e;
      }
    }
  }
  return out;
}

async function filterEventsForReadAccess(
  events: ObjectChangeEvent[],
  request: PrimitiveInvocationRequest<unknown>,
): Promise<ObjectChangeEvent[]> {
  return (await partitionEventsForReadAccess(events, request)).map((p) => p.event);
}

export function createObjectHistoryPrimitiveHandlers() {
  return {
    "change_set_undo": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.changeSetUndoSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "change_set_undo requires an authenticated org context",
        );
      }

      const loaded = loadChangeSet(input.changeSetId, {
        orgId: getActorExt(request.actor).orgId,
      });
      if (!loaded) {
        return { ok: false as const, reason: "not-found" as const };
      }

      // Authz: enforce object.update / create / delete on every affected
      // object via the CURRENT actor. All-or-none.
      for (const event of loaded.events) {
        const ref: ResourceForAccessCheck = {
          resourceType: "object",
          resourceId: event.objectId,
          organizationId: event.orgId,
          ownerLevel: normalizeOwnerLevel(event.ownerLevel ?? "organization"),
          ownerId: event.ownerId ?? "",
          visibility:
            (event.visibility as ResourceForAccessCheck["visibility"]) ??
            "organization",
        };
        const mode =
          event.operation === "create"
            ? "object.delete"
            : event.operation === "soft-delete" ||
                event.operation === "tombstone"
              ? "object.create"
              : "object.update";
        await enforceResourceAccess(ref, request.actor, mode);
      }

      // Resolve external freshness for any CMS-tagged events before
      // starting writes.
      const externalFreshness = await resolveExternalFreshness(loaded, {
        orgId: actorExt.orgId,
      });
      // The user-reachable primitive no longer accepts bypassEligibility. The
      // engine still supports it for the internal platform-admin force-restore
      // primitive.
      const result = restoreChangeSet({
        changeSetId: input.changeSetId,
        actor: actorFromRequest(request),
        externalFreshness,
      });
      return {
        ok: true as const,
        restoreChangeSetId: result.restoreChangeSetId,
        appliedEventCount: result.appliedEventCount,
        affectedObjects: result.affectedObjects,
      };
    },

    "object_version_restore": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.objectVersionRestoreSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "object_version_restore requires an authenticated org context",
        );
      }
      const target = readObjectScopeById(input.objectId, { orgId });
      if (!target) {
        return { ok: false as const, reason: "not-found" as const };
      }
      await enforceResourceAccess(
        buildObjectResourceCheck(target),
        request.actor,
        "object.update",
      );
      const result = await restoreObjectToVersion({
        objectId: input.objectId,
        targetVersion: input.targetVersion,
        actor: actorFromRequest(request),
      });
      return {
        ok: true as const,
        restoreChangeSetId: result.restoreChangeSetId,
        appliedEventCount: result.appliedEventCount,
        affectedObjects: result.affectedObjects,
      };
    },

    "change_set_get": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.changeSetGetSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      // History reads MUST be scoped to the actor's organization. Orgless
      // actors are rejected unless the dev bypass is active.
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "change_set_get requires an authenticated org context (actor.orgId is null)",
        );
      }
      const loaded = loadChangeSet(input.changeSetId, {
        orgId: actorExt.orgId,
      });
      if (!loaded) {
        return { ok: false as const, reason: "not-found" as const };
      }
      const filteredEvents = await filterEventsForReadAccess(
        loaded.events,
        request,
      );
      const view: LoadedChangeSet = {
        changeSet: loaded.changeSet,
        events: filteredEvents,
      };
      const eligibility = input.includeEligibility
        ? summarizeChangeSetEligibility(view)
        : null;
      return {
        ok: true as const,
        changeSet: view.changeSet,
        events: view.events,
        eligibility,
      };
    },

    "change_set_list": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.changeSetListSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      // orgId is NEVER caller-supplied AND the actor must HAVE one. Orgless
      // actors cannot enumerate change_sets — that would be an unscoped-list
      // leak.
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "change_set_list requires an authenticated org context (actor.orgId is null)",
        );
      }
      const items = listChangeSets({
        orgId: actorExt.orgId,
        runId: input.runId,
        limit: input.limit,
        cursor: input.cursor,
        // Filter/search pass-through (all optional).
        objectId: input.objectId,
        actorId: input.actorId,
        effectRollup: input.effectRollup,
        restorable: input.restorable,
        createdAfter: input.createdAfter,
        createdBefore: input.createdBefore,
        closedAtAfter: input.closedAtAfter,
      });
      return { ok: true as const, items };
    },

    "object_history_list": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.objectHistoryListSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "object_history_list requires an authenticated org context (actor.orgId is null)",
        );
      }
      const orgId = actorExt.orgId;
      const target = readObjectScopeById(input.objectId, { orgId });
      if (!target) {
        return { ok: false as const, reason: "not-found" as const };
      }
      await enforceResourceAccess(
        buildObjectResourceCheck(target),
        request.actor,
        "object.read",
      );
      const events = listEventsForObject(input.objectId, {
        limit: input.limit,
        orgId: target.orgId,
      });
      return { ok: true as const, events };
    },

    "change_set_eligibility_get": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.changeSetEligibilityGetSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "change_set_eligibility_get requires an authenticated org context (actor.orgId is null)",
        );
      }
      const loaded = loadChangeSet(input.changeSetId, {
        orgId: actorExt.orgId,
      });
      if (!loaded) {
        return { ok: false as const, reason: "not-found" as const };
      }
      const eligibility = summarizeChangeSetEligibility(loaded);
      return { ok: true as const, eligibility };
    },

    // Freshness probe. Reader-authz (org + per-event read); NOT in the
    // delegated-chat allowlist. Redacted events are read-filtered first (their
    // remoteRevisionRef is scrubbed) so freshness is resolved ONLY for
    // readable CMS-tagged events (partial visibility).
    "freshness_check_for_change_set": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.freshnessCheckForChangeSetSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "freshness_check_for_change_set requires an authenticated org context (actor.orgId is null)",
        );
      }
      const loaded = loadChangeSet(input.changeSetId, { orgId: actorExt.orgId });
      if (!loaded) {
        return { ok: false as const, reason: "not-found" as const };
      }
      const filteredEvents = await filterEventsForReadAccess(loaded.events, request);
      const view: LoadedChangeSet = {
        changeSet: loaded.changeSet,
        events: filteredEvents,
      };
      const results = await freshnessCheckForChangeSet(view, {
        orgId: actorExt.orgId,
      });
      return { ok: true as const, results };
    },

    // Remote-effect attempts list. Reader authz (org + per-event read); NOT in
    // the delegated-chat allowlist. Attempts are returned only for events the
    // actor can read (partial visibility).
    "remote_effect_attempts_list_for_change_set": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.remoteEffectAttemptsListForChangeSetSchema.parse(
        request.input,
      );
      const actorExt = getActorExt(request.actor);
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "remote_effect_attempts_list_for_change_set requires an authenticated org context (actor.orgId is null)",
        );
      }
      const loaded = loadChangeSet(input.changeSetId, { orgId: actorExt.orgId });
      if (!loaded) {
        return { ok: false as const, reason: "not-found" as const };
      }
      // Use the EXPLICIT per-event read verdict (not snapshot survival) so
      // attempts are restricted to events the actor genuinely can read.
      const partitioned = await partitionEventsForReadAccess(loaded.events, request);
      const readableEventIds = new Set(
        partitioned.filter((p) => p.canRead).map((p) => p.event.id),
      );
      const all = listRemoteEffectAttemptsForChangeSet({
        changeSetId: input.changeSetId,
        orgId: actorExt.orgId,
      });
      const attempts = all.filter((a) => readableEventIds.has(a.changeEventId));
      return { ok: true as const, attempts };
    },

    // Admin retry. platform_admin ONLY. Mints a fresh idempotency key +
    // resolves a connector restore callable; returns `unsupported` when none
    // is registered (no silent no-op).
    "remote_effect_attempt_retry": async (
      request: PrimitiveInvocationRequest<unknown>,
    ) => {
      const input = schemas.remoteEffectAttemptRetrySchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      if (!actorExt.orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "remote_effect_attempt_retry requires an authenticated org context (actor.orgId is null)",
        );
      }
      const platformRole = (request.actor as { platformRole?: string } | null)
        ?.platformRole;
      if (platformRole !== "platform_admin") {
        return { ok: false as const, reason: "forbidden" as const };
      }
      const result = await retryRemoteEffect({
        attemptId: input.attemptId,
        orgId: actorExt.orgId,
      });
      return result;
    },
  };
}
