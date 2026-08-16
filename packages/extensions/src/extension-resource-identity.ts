import "server-only";

// ---------------------------------------------------------------------------
// Canonical resource-identity resolver.
//
// The ONLY place that maps a kind-specific locator to the polymorphic
// `resource_id` used by extension_access_policy / extension_co_owners. For
// connector / artifact / workflow kinds the canonical resource_id IS the
// `installed_extension.id` — org scoping comes free from
// the row's organization_id, and lifecycle teardown is per-row.
//
// No call site should construct a connector/artifact/workflow resource_id by
// hand — they go through this resolver so the identity scheme stays in one
// place (and the live installer can reuse it).
// ---------------------------------------------------------------------------

import {
  readInstalledExtensionById,
  readInstalledExtensionByIdentity,
} from "./canonical-store";
import type { InstalledExtension } from "./canonical-types";
import type { ExtensionOwnerContext } from "./enforce-extension-access";
import { workspaceAnchorIdentity } from "./canonical-types";

export type ResolvedExtensionResource = {
  /** The polymorphic resource_id = installed_extension.id. */
  resourceId: string;
  owner: ExtensionOwnerContext;
};

function toOwnerContext(row: InstalledExtension): ExtensionOwnerContext {
  return {
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
  };
}

/**
 * Resolve the canonical connector install row → resource identity, THE
 * EFFECTIVE ROW (cinatra#2694 / S3 #2697, re-grounded by S4 #2698 change 1).
 *
 * Resolution order — the rule shared by all three connector-resolution seams:
 *   1. the LIVE WORKSPACE-ANCHORED row `(NULL, 'workspace', '__platform__',
 *      packageName)` — one row that serves EVERY organization, because it names
 *      no owning org for the cross-org guard to fence. While it lives it
 *      SUPERSEDES the organization's own row (owner ruling 2026-08-16), so it is
 *      consulted FIRST;
 *   2. otherwise the ORGANIZATION's own row `(organizationId, 'organization',
 *      organizationId, packageName)`.
 *
 * S3 shipped this pair in the opposite order. The inversion is load-bearing, not
 * cosmetic: identity reads return ARCHIVED rows too, and a workspace install now
 * archives the organization's row in place — so an org-first order would resolve
 * the SUPERSEDED, archived row and bind the connector's permissions and owner
 * context to an install that is no longer in force. Where no live workspace row
 * exists the organization arm runs exactly as before, byte-identically.
 *
 * A row of the wrong KIND fails closed at whichever arm resolved it (the auth
 * gate must never evaluate a non-connector as a connector); a live workspace row
 * of the wrong kind does NOT fall through to the org arm — the effective row
 * already answered for that package name.
 *
 * Returns null when neither row exists (the connector shim then falls back to
 * the legacy connector_access_policy read — absence-only fallback).
 *
 * The org-LESS caller (`organizationId` null/undefined) is unchanged: it
 * resolves nothing. S3's contract is that the workspace row serves every
 * ORGANIZATION; widening it to an actor with no active organization is not this
 * slice's mandate and no caller needs it (the sync resolver's `!orgId` arm has
 * the identical posture).
 */
export async function resolveConnectorResource(
  organizationId: string | null | undefined,
  packageName: string,
): Promise<ResolvedExtensionResource | null> {
  if (!organizationId) return null;
  const workspaceRow = await readInstalledExtensionByIdentity(
    workspaceAnchorIdentity(packageName),
  );
  if (workspaceRow && (workspaceRow.status === "active" || workspaceRow.status === "locked")) {
    if (workspaceRow.kind !== "connector") return null;
    return { resourceId: workspaceRow.id, owner: toOwnerContext(workspaceRow) };
  }
  const orgRow = await readInstalledExtensionByIdentity({
    organizationId,
    ownerLevel: "organization",
    ownerId: organizationId,
    packageName,
  });
  if (orgRow) {
    if (orgRow.kind !== "connector") return null;
    return { resourceId: orgRow.id, owner: toOwnerContext(orgRow) };
  }
  if (!workspaceRow || workspaceRow.kind !== "connector") return null;
  return { resourceId: workspaceRow.id, owner: toOwnerContext(workspaceRow) };
}

/**
 * Resolve an artifact/workflow (or any installed-extension-anchored) resource
 * by its canonical `installed_extension.id`. Returns null when the row is
 * absent OR its kind does not match `expectedKind` — fail closed on a
 * {kind, id} mismatch so the auth gate can't evaluate the wrong resource.
 */
export async function resolveInstalledExtensionResource(
  installedExtensionId: string,
  expectedKind?: "agent" | "connector" | "artifact" | "skill" | "workflow",
): Promise<ResolvedExtensionResource | null> {
  const row = await readInstalledExtensionById(installedExtensionId);
  if (!row) return null;
  if (expectedKind && row.kind !== expectedKind) return null;
  return { resourceId: row.id, owner: toOwnerContext(row) };
}
