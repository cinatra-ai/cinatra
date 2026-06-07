import "server-only";

/**
 * Connector access scope guard.
 *
 * `guardConnectorAccess(connectorId, actor)` looks up a connector's
 * ownership tuple and routes the visibility check through
 * `enforceRunAccess()` from the agent-builder authorization kernel.
 * This is the single canonical authorization path for LLM-reachable
 * connector reads (Gmail, Apollo, WordPress, LinkedIn, etc.) — never
 * use ad-hoc `row.organizationId !== actor.organizationId` patterns.
 *
 * Behaviour:
 *   - When called with no actor argument (undefined), the guard calls
 *     `getActorContextOrThrow()` so a missing ALS frame surfaces as
 *     `ACTOR_CONTEXT_MISSING` and fails closed.
 *   - On kernel deny (AuthzError), throws an Error with
 *     `code: "CONNECTOR_ACCESS_DENIED"`.
 *   - When the connector row has null ownership (legacy), the lookup
 *     in `connectors-store` synthesizes a visibility from the legacy
 *     `scope` column (visibility='org' for global/org-scoped rows,
 *     'owner' for user-scoped rows).
 */

import type { ActorContext } from "@/lib/authz/actor-context";
import { getActorContextOrThrow } from "@cinatra-ai/llm/actor-context";
import { readConnectorOwnershipById } from "@/lib/connectors-store";
import { enforceRunAccess } from "@cinatra-ai/agents/auth-policy";

export const CONNECTOR_ACCESS_DENIED = "CONNECTOR_ACCESS_DENIED";

export async function guardConnectorAccess(
  connectorId: string,
  actor: ActorContext | undefined,
): Promise<void> {
  // Fail-closed: if the caller did not pass an actor, demand an ALS frame.
  const resolved = actor ?? getActorContextOrThrow();

  const ownership = await readConnectorOwnershipById(connectorId);
  if (!ownership) {
    const err = new Error(`Connector not found: ${connectorId}`);
    (err as Error & { code: string }).code = CONNECTOR_ACCESS_DENIED;
    throw err;
  }

  // Workspace-scoped connectors are visible to every authenticated workspace
  // principal for READ — independent of orgId, teamIds, or role. The
  // fail-closed actor check above guarantees the principal is authenticated;
  // setup/manage gating (org_admin/org_owner) is the route handler's job,
  // not the read guard's.
  if (ownership.ownerType === "workspace") {
    return;
  }

  // Map the connector ownership tuple into a RunForAccessCheck-shaped probe so
  // we can reuse the enforceRunAccess kernel for visibility branching.
  const probe = {
    id: ownership.connectorId,
    runBy: ownership.ownerType === "user" ? ownership.ownerId : null,
    orgId: ownership.organizationId,
    // No effectivePolicy — the kernel will just consult role + token-scope.
  };

  // The kernel's PrimitiveActorContext shape and ActorContext overlap on the
  // fields enforceRunAccess actually reads (userId via principalId,
  // organizationId, platformRole). We adapt by passing a thin shim.
  const primitiveActor = {
    userId: resolved.principalId,
    organizationId: resolved.organizationId,
    actorType:
      resolved.principalType === "HumanUser"
        ? "human"
        : resolved.principalType === "ExternalA2AAgent"
          ? "a2a"
          : resolved.principalType === "ServiceAccount"
            ? "model"
            : "system",
    source: resolved.authSource,
  } as Parameters<typeof enforceRunAccess>[1];

  try {
    await enforceRunAccess(probe, primitiveActor, "read", {
      orgRole: resolved.orgRole,
      actorOrganizationId: resolved.organizationId,
    } as Parameters<typeof enforceRunAccess>[3]);
  } catch (kernelErr) {
    const err = new Error(
      `Connector access denied: ${connectorId}`,
    );
    (err as Error & { code: string; cause?: unknown }).code = CONNECTOR_ACCESS_DENIED;
    (err as Error & { cause?: unknown }).cause = kernelErr;
    throw err;
  }
}
