/**
 * Canonical `requireAccess` enforcement primitive.
 *
 * A single canonical primitive at `src/lib/authz` wraps the existing `can()`
 * predicate and the registry, then emits audit events on every decision.
 * Package-local helpers can act as adapters that delegate here while sharing
 * the same enforcement and audit behavior.
 *
 * Behavior:
 *   1. Resolve `(resource.resourceType, action)` against the central
 *      registry. Missing entry -> fail-closed deny with `forbidden`.
 *   2. Apply optional `requireRole` gate by checking the actor's
 *      `roles[]`/synthetic-role surface against the required role.
 *   3. Delegate to `can(actor, requiredPermission, resource)` for the
 *      core authorization decision.
 *   4. Emit a structured `logAuditEvent` (allowed or denied).
 *   5. Throw `AuthzError` on deny.
 *
 * Carve-outs: a primitive may register a `CarveOut` (see `./carve-out.ts`)
 * that bypasses registry enforcement at a named boundary. `requireAccess`
 * never silently skips; callers that intentionally bypass must pass an
 * explicit `carveOutRef`, and test coverage verifies the carve-out is still
 * listed in `CARVE_OUTS`.
 */
import "server-only";

import type { ActorContext, ProjectGrant } from "./actor-context";
import { logAuditEvent, type AuditEventInput } from "./audit";
import { AuthzError } from "./errors";
import { can } from "./enforce";
import type { ResourceRef } from "./resource-ref";
import type { Role } from "./policies";
import { type Action, lookupClassification } from "./registry";
import { findCarveOut, type CarveOutRef } from "./carve-out";

export type RequireAccessOpts = {
  /**
   * Optional named carve-out. Caller asserts the bypass is registered in
   * `CARVE_OUTS`; test coverage enforces that the bypass exists in code
   * and that no stale carve-out lingers. `requireAccess` short-circuits to
   * "allowed" when a valid carve-out is provided and logs the bypass as
   * `decision:"allowed"` + `metadata.carveOut:true`.
   */
  carveOut?: CarveOutRef;
  /**
   * Optional projectId, used when the caller's authorization should
   * additionally require an explicit project_access grant for a
   * project-scoped resource.
   */
  requireProjectGrant?: string;
  /** Primitive name for audit attribution (e.g. "agent_run_create"). */
  primitiveName?: string;
};

function actorHoldsRole(actor: ActorContext, role: Role): boolean {
  const roles = (actor as ActorContext & { roles?: string[] }).roles ?? [];
  if (roles.includes(role)) return true;
  // Synthetic single-bag role hints carried on the actor.
  if (role === "platform_admin" && actor.platformRole === "platform_admin") return true;
  if (role === "org_owner" && actor.orgRole === "org_owner") return true;
  if (role === "org_admin" && actor.orgRole === "org_admin") return true;
  if (role === "member" && actor.orgRole === "member") return true;
  return false;
}

function actorHoldsProjectGrant(actor: ActorContext, projectId: string): boolean {
  const grants = (actor.projectGrants ?? []) as ProjectGrant[];
  return grants.some((g) => g.projectId === projectId);
}

/**
 * Canonical entry point. Throws `AuthzError` on deny.
 *
 * Behavior contract:
 *   - Missing registry entry -> 403 forbidden (deny-by-default; test coverage
 *     ensures every reachable primitive has an entry).
 *   - `requireRole` mismatch -> 403 forbidden, audited.
 *   - `can()` false -> 403 forbidden, audited.
 *   - `requireProjectGrant` not held -> 403 forbidden, audited.
 *   - Valid `carveOut` -> allowed, audited as a bypass.
 */
export async function requireAccess(
  actor: ActorContext,
  resource: ResourceRef,
  action: Action,
  opts?: RequireAccessOpts,
): Promise<void> {
  const baseAudit: AuditEventInput = {
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    actorPrincipalType:
      actor.principalType === "HumanUser"
        ? "human"
        : actor.principalType === "ServiceAccount" || actor.principalType === "InternalWorker"
          ? "system"
          : actor.principalType === "ExternalA2AAgent"
            ? "a2a"
            : "system",
    authSource: "mcp",
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    operation: opts?.primitiveName ?? action,
    policyVersion: "canonical-authz",
  };

  // Carve-out short-circuit. Must be a registered, non-stale entry.
  if (opts?.carveOut) {
    const carve = findCarveOut(opts.carveOut);
    if (!carve) {
      // Caller named a carve-out that does NOT exist; fail closed.
      await logAuditEvent({
        ...baseAudit,
        decision: "denied",
        metadata: { reason: "unknown_carve_out", carveOutRef: opts.carveOut },
      });
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: `Unknown carve-out: ${opts.carveOut.primitiveName}`,
      });
    }
    await logAuditEvent({
      ...baseAudit,
      decision: "allowed",
      metadata: { carveOut: true, primitiveName: carve.primitiveName, risk: carve.risk },
    });
    return;
  }

  const classification = lookupClassification(resource.resourceType, action);
  if (!classification) {
    await logAuditEvent({
      ...baseAudit,
      decision: "denied",
      metadata: { reason: "missing_classification" },
    });
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `No classification entry for ${resource.resourceType}::${action}`,
    });
  }

  // Optional role gate. Applied BEFORE the can() permission check so the
  // audit event can attribute "denied_by_role" precisely.
  if (classification.requiredAccess.requireRole) {
    const required = classification.requiredAccess.requireRole;
    if (!actorHoldsRole(actor, required)) {
      await logAuditEvent({
        ...baseAudit,
        decision: "denied",
        metadata: { reason: "missing_role", required },
      });
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: `Role ${required} required for ${resource.resourceType}::${action}`,
      });
    }
  }

  // Core permission check via the existing `can()` predicate.
  const allowed = can(actor, classification.requiredAccess.requiredPermission, resource);
  if (!allowed) {
    await logAuditEvent({
      ...baseAudit,
      decision: "denied",
      metadata: {
        reason: "denied_by_permission",
        requiredPermission: classification.requiredAccess.requiredPermission,
      },
    });
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Missing ${classification.requiredAccess.requiredPermission} for ${resource.resourceType}::${action}`,
    });
  }

  // Optional project_access grant additionally required by the caller.
  if (opts?.requireProjectGrant) {
    const pid = opts.requireProjectGrant;
    if (!actorHoldsProjectGrant(actor, pid)) {
      await logAuditEvent({
        ...baseAudit,
        decision: "denied",
        metadata: { reason: "missing_project_grant", projectId: pid },
      });
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: `Missing project_access grant for project ${pid}`,
      });
    }
  }

  await logAuditEvent({
    ...baseAudit,
    decision: "allowed",
    metadata: {
      requiredPermission: classification.requiredAccess.requiredPermission,
      effect: classification.effect,
    },
  });
}

/**
 * Pure predicate variant of `requireAccess`. Returns the structured decision
 * without throwing; useful for UI gating where the rendered surface picks
 * between "show" / "show-with-tooltip" / "hide" based on the reason.
 *
 * Does NOT emit an audit event; the caller is expected to act on the
 * decision through a real authz path that audits.
 */
export function canRequireAccess(
  actor: ActorContext,
  resource: ResourceRef,
  action: Action,
  opts?: { requireProjectGrant?: string },
): { allowed: true } | { allowed: false; reason: string } {
  const classification = lookupClassification(resource.resourceType, action);
  if (!classification) {
    return { allowed: false, reason: "missing_classification" };
  }
  if (classification.requiredAccess.requireRole && !actorHoldsRole(actor, classification.requiredAccess.requireRole)) {
    return { allowed: false, reason: "missing_role" };
  }
  if (!can(actor, classification.requiredAccess.requiredPermission, resource)) {
    return { allowed: false, reason: "denied_by_permission" };
  }
  if (opts?.requireProjectGrant && !actorHoldsProjectGrant(actor, opts.requireProjectGrant)) {
    return { allowed: false, reason: "missing_project_grant" };
  }
  return { allowed: true };
}
