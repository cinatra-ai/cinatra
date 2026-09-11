/**
 * Authorization bypass convention.
 *
 * Single helper through which platform_admin write powers on user-owned
 * resources flow. Every successful call writes a durable audit row BEFORE
 * the helper resolves — audit-write failure aborts the caller's mutation
 * (logAuditEventStrict propagates DB errors).
 *
 * Use this helper for moderation, GDPR-deletion, ownership transfer,
 * incident response, and compliance audits. Do NOT add resource-CRUD
 * permissions to platform_admin's DIRECT_GRANTS in policies.ts — the
 * invariant test fails CI when that regresses.
 *
 * See https://docs.cinatra.ai/references/platform/authz-admin-powers/ for the full rationale.
 */
import "server-only";

import { AuthzError } from "./errors";
import { logAuditEventStrict } from "./audit";
import type { ActorContext } from "./actor-context";
import type { ResourceRef } from "./resource-ref";

/**
 * The exceptional purposes a platform admin may act for.
 *
 * The two CONFIGURATION members (cinatra#2813 S1, epic #2812) widen this
 * union deliberately, and the argument is worth stating because the others
 * all answer an emergency. Per-scope assignment has a tier — the true
 * workspace tier — that applies to every organization on the instance, and
 * nothing below the platform can decide it: no organization role grants
 * authority over all organizations, and inventing one would be a far larger
 * widening than this. So the workspace tier has NO grant road at all, and a
 * platform admin reaches it only here, where the audit row is written BEFORE
 * the mutation.
 *
 *  - `workspace_configuration` — a workspace-tier assignment row.
 *  - `scope_configuration` — a platform-admin write at organization, team,
 *    project or user scope. Separate from the above because the two are
 *    different acts with different blast radii, and an auditor reading one
 *    shared reason could not tell them apart.
 */
export type AdminBypassReason =
  | "moderation"
  | "gdpr_request"
  | "ownership_transfer"
  | "incident_response"
  | "compliance_audit"
  | "workspace_configuration"
  | "scope_configuration";

export async function withPlatformAdminBypass(
  actor: ActorContext,
  operation: string,
  resource: ResourceRef & { ownerId: string },
  reason: AdminBypassReason,
  extraMetadata?: Record<string, unknown>,
): Promise<{ auditEventId: string }> {
  if (actor.platformRole !== "platform_admin") {
    throw new AuthzError({ statusCode: 403, reason: "forbidden" });
  }
  // Spread extraMetadata FIRST so the canonical bypass metadata keys
  // (bypass, reason, originalOwnerId) override any caller-supplied
  // values. Tests lock this ordering so a malicious or buggy caller
  // cannot suppress `bypass: true` or rewrite `originalOwnerId`.
  const metadata: Record<string, unknown> = {
    ...(extraMetadata ?? {}),
    bypass: true,
    reason,
    originalOwnerId: resource.ownerId,
  };
  const result = await logAuditEventStrict({
    actorPrincipalId: actor.principalId,
    actorPrincipalType: "human",
    authSource: actor.authSource,
    organizationId: actor.organizationId,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    operation,
    decision: "allowed",
    policyVersion: actor.policyVersion,
    metadata,
  });
  return { auditEventId: result.id };
}
