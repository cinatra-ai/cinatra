import "server-only";

// Targeted-restore eligibility gate (app-artifacts §VI ruling,
// design@94cfbcf5). A targeted restore is authorized PER AFFECTED OBJECT — an
// actor may reverse a change-set only when they hold restore authorization for
// every object it touched, and the change-set is still restorable. This is the
// SAME per-object inverse-write check restoreChangeSetAction enforces on
// confirm, and it deliberately carries NO administrator bypass: the entry
// affordances (the in-chat Undo chip and the "Saved · Undo" toast) and the
// non-admin deep-link resolver all consult this ONE gate, so an ineligible
// actor — including an administrator who is not per-object-authorized for some
// affected object — gets no affordance and no targeted restore.
//
// The actor construction mirrors restoreChangeSetAction exactly (extracted here
// as `resolveSessionRestoreAuthz` so the two paths can never diverge on which
// actor + role hints the authz kernel sees).

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { requireAuthSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import {
  actorFromSession,
  type ActorFromSession,
  type ActorRoleHints,
} from "@/lib/authz/build-actor-context";
import { loadChangeSet } from "@/lib/object-history";
import { canActorRestoreChangeSet } from "@/lib/object-history/server-views";

type AuthSession = Awaited<ReturnType<typeof requireAuthSession>>;

/** A change-set loaded org-scoped AND authorized for the acting session. */
export type LoadedTargetedRestore = NonNullable<ReturnType<typeof loadChangeSet>>;

export type SessionRestoreAuthz = {
  primitiveActor: ActorFromSession;
  roleHints: ActorRoleHints | undefined;
};

/**
 * Build the authz actor + role hints the restore per-object check runs against
 * from a Better Auth session — the resolved org role hint so org-owned events
 * are not over-denied. Shared by restoreChangeSetAction (the confirm path) and
 * the eligibility gate below so both decide access with the identical actor.
 */
export async function resolveSessionRestoreAuthz(
  session: AuthSession,
): Promise<SessionRestoreAuthz> {
  const primitiveActor = actorFromSession(session);
  const orgRole = await resolveOrgRoleForSession(session);
  const roleHints = orgRole ? { orgRole } : undefined;
  return { primitiveActor, roleHints };
}

/**
 * Load `changeSetId` org-scoped AND authorized for the acting session as a
 * TARGETED restore, returning the loaded change-set (events + metadata) or null.
 * The verdict and the loaded payload come from ONE load, so a caller that
 * RENDERS the targeted restore uses the exact object that was authorized — no
 * check-then-reload TOCTOU that could dead-end on a lost / newly-non-restorable
 * change-set instead of falling back to Library.
 *
 * Returns null (fail-closed) for: an empty id, an orgless session, a missing /
 * foreign-org id, a non-restorable change-set (still-restorable is part of §VI
 * eligibility), a per-object authorization denial (no admin bypass), or any
 * unexpected error.
 */
export async function loadAuthorizedTargetedRestore(
  changeSetId: string,
): Promise<LoadedTargetedRestore | null> {
  // The empty id short-circuits BEFORE the session is touched: an affordance that
  // has no change-set to ask about must not cost a session read (and a test pins
  // exactly that).
  if (!changeSetId) return null;
  try {
    const session = await requireAuthSession();
    const orgId = session.session?.activeOrganizationId ?? null;
    if (!orgId) return null;
    const { primitiveActor, roleHints } = await resolveSessionRestoreAuthz(session);
    return await loadAuthorizedTargetedRestoreForActor({
      changeSetId,
      orgId,
      actor: primitiveActor,
      roleHints,
    });
  } catch {
    // Best-effort gate — degrade to "not authorized" rather than throw into a
    // chat render, a toast, or the artifacts page.
    return null;
  }
}

/**
 * The same gate, for an actor that is NOT a cookie session (cinatra#2683, epic
 * #2564 S8f).
 *
 * The widget's undo chip has to ask the identical question — "may THIS person
 * reverse this change-set?" — for a reader proven by a `cwu_` broker token
 * rather than by a cookie. Giving it a second implementation would have been the
 * defect: §VI's rule is per-object authorization with NO administrator bypass,
 * and a second copy of that rule is a second place for it to weaken.
 *
 * So the org-scoped load and the per-object check live HERE, take the actor as
 * an argument, and the session façade above is one caller of them. The widget
 * entry is the other, passing the S8a FULL actor and the org the TOKEN is bound
 * to — never a session's active org, which a widget request has no business
 * reading.
 */
export async function loadAuthorizedTargetedRestoreForActor(input: {
  changeSetId: string;
  orgId: string;
  actor: ActorFromSession | PrimitiveActorContext;
  roleHints: ActorRoleHints | undefined;
}): Promise<LoadedTargetedRestore | null> {
  if (!input.changeSetId || !input.orgId) return null;
  try {
    // Org-scoped load — a foreign-org or unknown id returns null (never leaks).
    const loaded = loadChangeSet(input.changeSetId, { orgId: input.orgId });
    if (!loaded) return null;
    if (!loaded.changeSet.restorable) return null;
    const authorized = await canActorRestoreChangeSet(
      loaded.events,
      input.actor,
      input.roleHints,
    );
    return authorized ? loaded : null;
  } catch {
    return null;
  }
}

/**
 * Boolean façade over {@link loadAuthorizedTargetedRestore} for the entry
 * affordances (chip + toast), which only need "may this actor act?", not the
 * loaded change-set.
 */
export async function isSessionEligibleForTargetedRestore(
  changeSetId: string,
): Promise<boolean> {
  return (await loadAuthorizedTargetedRestore(changeSetId)) !== null;
}
