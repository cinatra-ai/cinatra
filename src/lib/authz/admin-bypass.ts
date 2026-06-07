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

export type AdminBypassReason =
  | "moderation"
  | "gdpr_request"
  | "ownership_transfer"
  | "incident_response"
  | "compliance_audit";

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
