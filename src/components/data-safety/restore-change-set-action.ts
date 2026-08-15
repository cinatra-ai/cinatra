"use server";

import { getAuthSession, isPlatformAdmin, requireAdminSession } from "@/lib/auth-session";
import {
  loadChangeSet,
  resolveExternalFreshness,
  restoreChangeSet,
  type HistoryActor,
} from "@/lib/object-history";
import { assertChangeSetRestoreAccess } from "@/lib/object-history/server-views";
import {
  isSessionEligibleForTargetedRestore,
  resolveSessionRestoreAuthz,
} from "@/lib/object-history/restore-eligibility";
import { AuthzError } from "@/lib/authz/errors";
import { verifySessionAuthority } from "@/lib/org-write/authority";

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
  // PLATFORM-ADMIN gate (cinatra#2700, epic #2699). Restore is a
  // `/configuration/artifacts` capability, and the whole segment is admin-only,
  // so member self-service restore retires HERE — at the action — not only on
  // the page: a server action never passes through the segment layout, and the
  // affordances S2 removes must not stay invokable underneath. The per-object
  // authorization below is unchanged and still runs on top of this gate (an
  // admin is NOT granted a per-object bypass).
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, reason: "no active organization on session" };
  }
  // Build a PrimitiveActorContext from the session + resolve the org role
  // hint so enforceResourceAccess sees the user's full role grants.
  // Without this, org-owned events are over-denied. Shared with the entry-
  // affordance eligibility gate so both decide access with the identical actor.
  const { primitiveActor, roleHints } = await resolveSessionRestoreAuthz(session);
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

  // Org-write kernel authority (cinatra#1939 wave 3 Stage D) — independent of
  // the per-object RBAC loop above (roleHints there is a read-side hint, not
  // an org-write capability grant).
  const authority = await verifySessionAuthority(session.user.id, orgId);

  try {
    const result = restoreChangeSet({
      changeSetId: input.changeSetId,
      actor,
      externalFreshness,
      authority,
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

// Server action for the "Saved · Undo" toast (§VI): answers whether the acting
// user is eligible to restore `changeSetId` as a TARGETED restore, so the
// client toast can render its Undo affordance ONLY for an eligible actor
// (per-object-authorized, still restorable, no admin bypass). Delegates to the
// shared gate so it can never diverge from the confirm path's authorization.
//
// It now reports TWO facts, not one (cinatra#2701, epic #2699 S2). The Undo
// affordance deep-links into `/configuration/artifacts/...`, which is admin-only,
// and `restoreChangeSetAction` above refuses a non-admin outright — so a
// non-admin must be offered no link. But "no link" is not the same as "no
// feedback": the epic's aligned-affordances rule is that the toast INFORMS
// without a link, rather than the save going silent. `admin` is what lets the
// toast tell those two states apart, and it is resolved HERE, server-side, from
// the session — never asserted by the client.
//
// `eligible` keeps its exact meaning and stays admin-independent in spirit: for
// a non-admin it is false because the surface is unreachable, and for an admin
// the §VI per-object gate decides exactly as before (no admin bypass).
export async function canRestoreChangeSetAction(input: {
  changeSetId: string;
}): Promise<{ eligible: boolean; admin: boolean }> {
  const admin = isPlatformAdmin(await getAuthSession());
  if (!admin) return { eligible: false, admin: false };
  return {
    eligible: await isSessionEligibleForTargetedRestore(input.changeSetId),
    admin: true,
  };
}
