"use server";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  loadChangeSet,
  resolveExternalFreshness,
  restoreChangeSet,
  type HistoryActor,
} from "@/lib/object-history";
import { assertChangeSetRestoreAccess } from "@/lib/object-history/server-views";
import { AuthzError } from "@/lib/authz/errors";
import { actorFromSession } from "@/lib/authz/build-actor-context";

// Server action: invoke change_set_undo. Mirrors the MCP handler's per-
// object authz loop + pre-fetches external freshness. NEVER exposes a
// bypass — UI users do not get an eligibility bypass.
//
// Extracted out of the change-sets route so the inline
// per-object undo affordance (`<UndoLastAction>`) can reuse the exact same
// restore path the change-set detail page uses (reuses the
// <RestoreModal> + restoreChangeSetAction path). The route's
// actions.ts re-exports this symbol for backward compatibility.
export async function restoreChangeSetAction(input: {
  changeSetId: string;
}): Promise<
  | { ok: true; restoreChangeSetId: string; appliedEventCount: number }
  | { ok: false; reason: string }
> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, reason: "no active organization on session" };
  }
  // Build a PrimitiveActorContext from the session + resolve the org role
  // hint so enforceResourceAccess sees the user's full role grants.
  // Without this, org-owned events are over-denied.
  const primitiveActor = actorFromSession(session);
  const orgRole = await resolveOrgRoleForSession(session);
  const roleHints = orgRole ? { orgRole } : undefined;
  const actor: HistoryActor = {
    actorId: session.user.id,
    actorKind: "user",
    orgId,
  };

  // Load org-scoped — id-reuse / cross-tenant safe.
  const loaded = loadChangeSet(input.changeSetId, { orgId });
  if (!loaded) {
    return { ok: false, reason: "change-set not found" };
  }

  // Per-object authz on every affected event (mirrors the MCP handler).
  // The engine doesn't enforce this; the caller surface MUST. Shared with the
  // deep-link auto-open gate so the same logic decides "can auto-open"
  // and "can confirm" (no auto-open-then-denied modal).
  try {
    await assertChangeSetRestoreAccess(loaded.events, primitiveActor, roleHints);
  } catch (e) {
    if (e instanceof AuthzError) {
      return {
        ok: false,
        reason: `authz denied for one or more affected objects: ${e.message}`,
      };
    }
    throw e;
  }

  // Resolve freshness for any CMS-tagged events.
  const externalFreshness = await resolveExternalFreshness(loaded, { orgId });

  try {
    const result = restoreChangeSet({
      changeSetId: input.changeSetId,
      actor,
      externalFreshness,
    });
    return {
      ok: true,
      restoreChangeSetId: result.restoreChangeSetId,
      appliedEventCount: result.appliedEventCount,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
