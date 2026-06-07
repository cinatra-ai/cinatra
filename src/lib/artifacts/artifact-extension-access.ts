import "server-only";

// ---------------------------------------------------------------------------
// Artifact-extension access gate.
//
// Bridges the artifact-authoring surfaces to the uniform polymorphic access
// model. An artifact extension's npm package name (the object-type id minus the
// `:artifact` suffix) IS its `installed_extension.package_name`, so we resolve
// the canonical install row and delegate to `canExtensionAccess`.
//
// Governance scope: ONLY install-tracked artifact extensions are governed. A
// disk-registered dev artifact with no `installed_extension` row is treated as
// ungoverned (allowed) — the access model governs INSTALLED extensions, and
// failing closed there would block every disk-registered dev artifact. A DB
// read error fails CLOSED (deny). The sealed-room project gate
// (assertProjectReadAccess) is orthogonal and unchanged.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  canExtensionAccess,
  type ExtensionAccessOp,
} from "@cinatra-ai/extensions/enforce-extension-access";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

/**
 * MCP-path actors carry platformRole but not orgRole. Resolve it from
 * (orgId, userId) so the owner-aware "admin" tier recognizes org admins/owners.
 * No-op when orgRole is already present (session path) or there's no human
 * user / org to resolve against.
 */
async function withResolvedOrgRole(
  actor: ActorContext | undefined | null,
): Promise<ActorContext | undefined | null> {
  if (!actor || actor.orgRole || actor.principalType !== "HumanUser" || !actor.organizationId) {
    return actor;
  }
  const orgRole = await resolveOrgRoleForUser(actor.organizationId, actor.principalId);
  return orgRole ? { ...actor, orgRole } : actor;
}

export async function canAccessArtifactExtension(
  packageName: string,
  actor: ActorContext | undefined | null,
  op: ExtensionAccessOp,
): Promise<boolean> {
  // Whole decision path is fail-closed: ANY access-store read error (the
  // install rows, the policy, or the co-owners) returns false rather than
  // throwing (which would 500 a sync-ish search/get path).
  try {
    const artifactRows = (await readInstalledExtensionsByPackageName(packageName)).filter(
      (r) => r.kind === "artifact",
    );
    if (artifactRows.length === 0) return true; // ungoverned (disk-registered dev artifact, no install row).

    // Only LIVE installs (active|locked) govern access. If an install row
    // exists but none are live (e.g. archived/removed), DENY — the extension
    // was deliberately taken down, even if a disk descriptor still lingers.
    const live = artifactRows.filter((r) => r.status === "active" || r.status === "locked");
    if (live.length === 0) return false;

    // Pick the row that governs this actor: org-owned for the actor's org,
    // then an ambient (platform/workspace) install, else the first live row.
    const orgId = actor?.organizationId;
    const row =
      (orgId && live.find((r) => r.organizationId === orgId)) ||
      live.find((r) => r.organizationId == null) ||
      live[0];

    const effectiveActor = await withResolvedOrgRole(actor);
    const decision = await canExtensionAccess(
      {
        kind: "artifact",
        resourceId: row.id,
        owner: {
          ownerLevel: row.ownerLevel,
          ownerId: row.ownerId,
          organizationId: row.organizationId,
        },
      },
      effectiveActor ?? null,
      op,
    );
    return decision.allowed;
  } catch {
    return false;
  }
}
