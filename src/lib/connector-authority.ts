/**
 * Connector Scope & Use Policy.
 *
 * Connector authority is evaluated at connector-instance and credential scope,
 * not just connector class:
 *
 *   - Child agents inherit a subset of the parent's authorized connector set
 *     through monotonic intersection, never expansion.
 *   - Agents declare each connector dependency as `required` or `optional`.
 *     Required missing dependencies fail closed at run-start. Optional missing
 *     dependencies emit an audited "skipped step" event.
 *
 * `requireConnectorAuthority` is the runtime entry point for connector use
 * checks. Configuration surfaces pass `mode: "manage"` for admin-only access.
 */
import "server-only";

import { enforceConnectorPolicy, type ConnectorPolicyMode } from "@/lib/connector-policy";
import { logAuditEvent } from "@/lib/authz/audit";
import type { ActorContext } from "@/lib/authz/actor-context";

export type ConnectorRequirement = "required" | "optional";

export type ConnectorDependencyDecl = {
  packageId: string;
  /** When `undefined`, default to `required` (most strict). */
  requirement?: ConnectorRequirement;
};

export type ConnectorAuthorityDecision =
  | { allowed: true; reason?: never; skipped?: never }
  | { allowed: false; reason: string; skipped: boolean };

/**
 * Resolve whether an actor is authorized to USE a specific connector package.
 *
 * `mode` defaults to "use" — the agent-runtime invocation gate. Pass
 * "manage" for connector configuration surfaces (admin only).
 *
 * Emits a structured audit event on every decision.
 */
export async function requireConnectorAuthority(
  packageId: string,
  actor: ActorContext,
  opts: { mode?: ConnectorPolicyMode; requirement?: ConnectorRequirement; instanceId?: string } = {},
): Promise<ConnectorAuthorityDecision> {
  const mode = opts.mode ?? "use";
  const requirement = opts.requirement ?? "required";
  const decision = enforceConnectorPolicy(packageId, actor, mode);
  if (decision.allowed) {
    await logAuditEvent({
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      actorPrincipalType: "human",
      authSource: "agent",
      resourceType: "connector_instance",
      resourceId: opts.instanceId ?? packageId,
      operation: mode,
      decision: "allowed",
      policyVersion: "connector-scope-use-policy",
      metadata: { packageId, visibility: decision.visibility, requirement },
    });
    return { allowed: true };
  }
  await logAuditEvent({
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    actorPrincipalType: "human",
    authSource: "agent",
    resourceType: "connector_instance",
    resourceId: opts.instanceId ?? packageId,
    operation: mode,
    decision: "denied",
    policyVersion: "connector-scope-use-policy",
    metadata: { packageId, reason: decision.reason ?? "no_grant", requirement },
  });
  return {
    allowed: false,
    reason: decision.reason ?? "no_grant",
    // `optional` deps emit a "skipped" decision the runtime can route through
    // an audited-but-non-fatal "skipped step" event. `required` deps must
    // fail closed at run-start.
    skipped: requirement === "optional",
  };
}

/**
 * Monotonic intersection: given a parent's authorized set, filter a candidate
 * child set so the child can only use what the parent was authorized for.
 * Used by the orchestrator before dispatching a child agent run.
 *
 * Both sets are package-id strings (and optionally per-instance ids).
 * `parentSet === undefined` returns the candidate unchanged (no
 * parent — orchestrator-less invocation).
 */
export function intersectAuthorizedConnectors(
  parentSet: ReadonlySet<string> | undefined,
  candidate: ReadonlySet<string>,
): Set<string> {
  if (!parentSet) return new Set(candidate);
  const out = new Set<string>();
  for (const id of candidate) {
    if (parentSet.has(id)) out.add(id);
  }
  return out;
}

/**
 * Evaluate a declared dependency set for run-start gating.
 * Walks the deps; for each, calls `requireConnectorAuthority`. Returns:
 *   - { ok: true, skipped: string[] }   — all required deps authorized.
 *   - { ok: false, failedRequired: string[] } — at least one required dep
 *     missing → run must fail closed.
 */
export async function evaluateConnectorDependencies(
  deps: readonly ConnectorDependencyDecl[],
  actor: ActorContext,
): Promise<{ ok: true; skipped: string[] } | { ok: false; failedRequired: string[]; skipped: string[] }> {
  const skipped: string[] = [];
  const failedRequired: string[] = [];
  for (const dep of deps) {
    const decision = await requireConnectorAuthority(dep.packageId, actor, {
      mode: "use",
      requirement: dep.requirement ?? "required",
    });
    if (!decision.allowed) {
      if (decision.skipped) skipped.push(dep.packageId);
      else failedRequired.push(dep.packageId);
    }
  }
  if (failedRequired.length > 0) {
    return { ok: false, failedRequired, skipped };
  }
  return { ok: true, skipped };
}
