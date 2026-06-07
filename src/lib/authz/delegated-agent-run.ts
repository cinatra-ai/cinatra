/**
 * Delegated execution-actor identity.
 *
 * An agent or workflow execution does not have a first-class principal. It
 * executes under a `DelegatedAgentRun` envelope derived from the instantiating
 * user's auth context and snapshotted onto the run record so re-validation
 * at start time + mid-run revocation can see the original authority.
 *
 * This module provides:
 *   - The type + builder.
 *   - A snapshot helper that captures the salient identity bits from an
 *     `ActorContext` into a JSON-serializable shape.
 *   - A reconstruct helper that materializes an `ActorContext`-shaped
 *     envelope from a persisted snapshot.
 *
 * The snapshot is persisted on `agent_runs.delegated_actor_snapshot`
 * (additive nullable JSON column). Legacy rows have `null` -> callers fall
 * back to deriving authority from the live session. New rows always carry
 * the snapshot.
 */

import "server-only";

import type { ActorContext, ProjectGrant } from "./actor-context";

/**
 * Subset of ActorContext persisted on the run row. Keep narrow — anything
 * stored here is replayed at run-start re-validation + mid-run authz
 * checks; growing the schema later is cheaper than carrying drift today.
 */
export type DelegatedAgentRunSnapshot = {
  /** Schema version. Bump when the shape changes; current = 1. */
  v: 1;
  /** Owning user id for inherited authority. */
  ownerUserId: string;
  /** Owning org id. */
  organizationId: string;
  /** Owning scope: who/what the run "belongs to" for authority purposes. */
  ownerScope: {
    level: "user" | "team" | "organization" | "workspace";
    recordId: string;
  };
  /** Project grants snapshotted at instantiate time. */
  projectGrants: ProjectGrant[];
  /** Team memberships at instantiate time. */
  teamIds: string[];
  /** Org role at instantiate time. */
  orgRole?: "org_owner" | "org_admin" | "member";
  /** Platform role at instantiate time. Almost always undefined. */
  platformRole?: "platform_admin" | "member";
  /** Per-scope role grants resolved from `role_grant`. */
  roles?: string[];
  /** Stamp for forensic correlation. */
  capturedAtIso: string;
};

/**
 * Capture the salient identity bits from a live ActorContext into a
 * persisted snapshot. Returns `undefined` when the actor is not a human —
 * delegated runs are only meaningful for HumanUser principals.
 */
export function captureDelegatedActorSnapshot(actor: ActorContext): DelegatedAgentRunSnapshot | undefined {
  if (actor.principalType !== "HumanUser") return undefined;
  const orgId = actor.organizationId;
  if (!orgId) return undefined;
  const teamIds = actor.teamIds ?? [];
  const projectGrants = actor.projectGrants ?? [];
  const ownerScope: DelegatedAgentRunSnapshot["ownerScope"] = teamIds.length > 0
    ? { level: "team", recordId: teamIds[0] }
    : { level: "organization", recordId: orgId };
  const snapshot: DelegatedAgentRunSnapshot = {
    v: 1,
    ownerUserId: actor.principalId,
    organizationId: orgId,
    ownerScope,
    projectGrants,
    teamIds,
    capturedAtIso: new Date().toISOString(),
  };
  if (actor.orgRole) snapshot.orgRole = actor.orgRole;
  if (actor.platformRole) snapshot.platformRole = actor.platformRole;
  const extraRoles = (actor as ActorContext & { roles?: string[] }).roles;
  if (Array.isArray(extraRoles) && extraRoles.length > 0) snapshot.roles = extraRoles;
  return snapshot;
}

/**
 * Reconstruct an ActorContext-shaped envelope from a persisted snapshot.
 * Used at run-start re-validation + mid-run authz checks so the canonical
 * `requireAccess` primitive sees the originating user's authority — not the
 * worker process's anonymous identity.
 *
 * If `liveGrants` is supplied, it OVERRIDES the snapshotted projectGrants
 * (used by mid-run revocation detection — a grant revoked between
 * instantiate and re-check fails closed).
 */
export function reconstructActorFromSnapshot(
  snapshot: DelegatedAgentRunSnapshot,
  opts?: { liveGrants?: ProjectGrant[] },
): ActorContext {
  const grants = opts?.liveGrants ?? snapshot.projectGrants;
  return {
    principalType: "HumanUser",
    principalId: snapshot.ownerUserId,
    authSource: "worker",
    policyVersion: "v2",
    organizationId: snapshot.organizationId,
    orgRole: snapshot.orgRole,
    platformRole: snapshot.platformRole,
    teamIds: snapshot.teamIds,
    projectGrants: grants,
    projectIds: grants.map((g) => g.projectId).sort(),
    ...(snapshot.roles && snapshot.roles.length > 0
      ? ({ roles: snapshot.roles } as Partial<ActorContext>)
      : {}),
  } as ActorContext;
}

/**
 * Detect a mid-run revocation: returns the projectIds present in the
 * snapshot but missing from the live grants.
 */
export function detectRevokedGrants(
  snapshot: DelegatedAgentRunSnapshot,
  liveGrants: ProjectGrant[],
): string[] {
  const live = new Set(liveGrants.map((g) => g.projectId));
  return snapshot.projectGrants.map((g) => g.projectId).filter((p) => !live.has(p));
}
