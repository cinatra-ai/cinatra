import "server-only";

/**
 * Minimal connector-ownership lookup used by `connectors-scope-guard`.
 * Pulls the ownership tuple (organization_id, owner_type, owner_id,
 * visibility) for an `external_mcp_servers` row and exposes it via a
 * stable shape so the scope guard can be tested without importing the
 * full registry module.
 */

import { getExternalMcpServerById } from "@/lib/external-mcp-registry";

export type ConnectorOwnership = {
  connectorId: string;
  organizationId: string | null;
  ownerType: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: string;
};

/**
 * Resolve the connector's ownership tuple by id. Maps the legacy `scope`
 * column to a visibility string so the kernel can treat connectors using
 * the same visibility branches as runs/skills.
 *
 * For rows that lack explicit ownership columns:
 *   - Treat `org_id` + scope='org'/'global' as visibility='org'.
 *   - Treat scope='user' as visibility='owner' (owner_id = user_id).
 */
export async function readConnectorOwnershipById(
  connectorId: string,
): Promise<ConnectorOwnership | null> {
  const row = getExternalMcpServerById(connectorId);
  if (!row) return null;

  const orgId = (row as unknown as { orgId?: string | null }).orgId ?? null;
  const userId = (row as unknown as { userId?: string | null }).userId ?? null;
  const scope = (row as unknown as { scope?: string | null }).scope ?? "global";

  // Default mapping: the registry today has no per-row visibility column;
  // synthesize from scope. Explicit ownership columns may later replace this.
  if (scope === "user" && userId) {
    return {
      connectorId: row.id,
      organizationId: orgId,
      ownerType: "user",
      ownerId: userId,
      visibility: "owner",
    };
  }
  // Workspace-scoped rows are visible to every authenticated
  // workspace principal regardless of orgId. The row may have orgId == null
  // when it represents a workspace-wide resource (e.g. the docker-local Twenty
  // CRM instance shared across all cinatra orgs in this deployment). The
  // anonymous-fails-closed contract still holds because the kernel guard
  // requires an actor frame before reaching this branch.
  if (scope === "workspace") {
    return {
      connectorId: row.id,
      organizationId: orgId,
      ownerType: "workspace",
      ownerId: row.id,
      visibility: "workspace",
    };
  }
  // Return null when neither userId nor orgId is present. Synthesizing
  // ownerId: "" let the empty string flow into probe-equality checks as a
  // silent mismatch; treating the row as "not visible" is fail-closed.
  if (!orgId) {
    return null;
  }
  return {
    connectorId: row.id,
    organizationId: orgId,
    ownerType: "organization",
    ownerId: orgId,
    visibility: "org",
  };
}
