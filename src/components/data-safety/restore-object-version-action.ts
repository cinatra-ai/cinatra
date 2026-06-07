"use server";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  restoreObjectToVersion,
  type HistoryActor,
  type MutationResult,
} from "@/lib/object-history";
import { getObjectById } from "@/lib/objects-store";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { actorFromSession } from "@/lib/authz/build-actor-context";

// Server action wrapping the existing object_version_restore
// MCP engine. Mirrors restoreChangeSetAction's authz
// pattern: requireAuthSession → org guard → PrimitiveActorContext + orgRole
// hints → per-object enforceResourceAccess("object.update") → engine call.
//
// The engine (restoreObjectToVersion) owns its own freshness pre-check +
// deleted/live transition handling + RestoreNotEligibleError on ineligible
// versions, so the action does not re-implement those.
//
// This is THE single vertical slice migrated to the
// MutationResult<T> contract. It threads the restore
// change-set id through to `changeSetId` so <UndoToast> can deep-link an undo.
// MutationResult is rolled out across every other write surface.
export async function restoreObjectToVersionAction(input: {
  objectId: string;
  targetVersion: number;
}): Promise<MutationResult<{ restoreChangeSetId: string; appliedEventCount: number }>> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, error: "no active organization on session" };
  }

  // Org-scoped lookup — id-reuse / cross-tenant safe. A row the actor's org
  // can't see returns null → not-found (hidden, not denied).
  const target = getObjectById(input.objectId, { orgId });
  if (!target) {
    return { ok: false, error: "object not found" };
  }

  const primitiveActor = actorFromSession(session);
  const orgRole = await resolveOrgRoleForSession(session);
  const roleHints = orgRole ? { orgRole } : undefined;

  // Per-object authz: restoring a prior version is an UPDATE on the object.
  try {
    await enforceResourceAccess(
      {
        resourceType: "object",
        resourceId: target.id,
        organizationId: target.orgId,
        ownerLevel: normalizeOwnerLevel(target.ownerLevel ?? "organization"),
        ownerId: target.ownerId ?? "",
        visibility:
          (target.visibility as "private" | "team" | "organization" | "public") ??
          "organization",
      },
      primitiveActor,
      "object.update",
      roleHints,
    );
  } catch (e) {
    if (e instanceof AuthzError) {
      return { ok: false, error: `authz denied: ${e.message}` };
    }
    throw e;
  }

  const actor: HistoryActor = {
    actorId: session.user.id,
    actorKind: "user",
    orgId,
  };

  try {
    const result = await restoreObjectToVersion({
      objectId: input.objectId,
      targetVersion: input.targetVersion,
      actor,
    });
    return {
      ok: true,
      data: {
        restoreChangeSetId: result.restoreChangeSetId,
        appliedEventCount: result.appliedEventCount,
      },
      // The NEW restore change-set is what an "Undo" would target.
      changeSetId: result.restoreChangeSetId,
      objectId: input.objectId,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
