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
 * Resolve the canonical org-scoped connector install row → resource identity.
 * Returns null when the org has no installed connector row for the package
 * (the connector shim then falls back to the legacy connector_access_policy
 * read — absence-only fallback).
 */
export async function resolveConnectorResource(
  organizationId: string | null | undefined,
  packageName: string,
): Promise<ResolvedExtensionResource | null> {
  if (!organizationId) return null;
  const row = await readInstalledExtensionByIdentity({
    organizationId,
    ownerLevel: "organization",
    ownerId: organizationId,
    packageName,
  });
  if (!row || row.kind !== "connector") return null;
  return { resourceId: row.id, owner: toOwnerContext(row) };
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
