// ---------------------------------------------------------------------------
// The dispatcher-side half of the target→ownership contract (cinatra#2694 /
// S2 #2696): which canonical row identity an install WRITES to.
//
// S1 (#2695) defined the CONTRACT — `accessTargetToRowOwnership` /
// `resolveInstallAccessTargetContract` in ./install-access-target — but nothing
// persisted it: the dispatcher derived the row anchor solely from the actor's
// active organization, so a "Workspace: All" install still wrote an org-anchored
// row. This module is the seam that closes that gap: the install action resolves
// the tuple, the dependency batch threads it per member, and the dispatcher
// resolves it HERE into the anchor the canonical row is created at.
//
// PURE (no IO, no server-only) so the resolution is directly unit-testable and
// so the host (`src/lib/extension-install-batch.ts`) can import it without
// dragging the dispatcher's import graph along.
// ---------------------------------------------------------------------------

import { PLATFORM_OWNER_SENTINEL } from "./canonical-types";
import type { InstallRowOwnership } from "./install-access-target";

export type { InstallRowOwnership };

/**
 * The ACTOR-DERIVED default anchor — the tuple the dispatcher has always
 * written: an install with an active organization is `organization`-owned; a
 * null-org install is `platform`-owned with a null ownerId the canonical store
 * platformizes on write. Byte-identical to `defaultRowOwnership(orgId)` in
 * src/lib/extension-dependency-plan.ts and to the organization/team/project
 * branch of `accessTargetToRowOwnership` (S1) — one rule, three call sites.
 */
export function actorDerivedRowAnchor(actorOrgId: string | null): InstallRowOwnership {
  const orgId = actorOrgId ?? null;
  return {
    ownerLevel: orgId ? "organization" : "platform",
    ownerId: orgId ?? null,
    organizationId: orgId ?? null,
  };
}

/**
 * Resolve the canonical row anchor an install writes at.
 *
 *  - `planned` ABSENT (every caller that does not thread the contract — the
 *    direct dispatcher paths, restore/reinstall, the MCP surface) → the
 *    actor-derived default. This is the whole pre-#2696 behavior, unchanged.
 *  - `planned` PRESENT → the planned tuple, verbatim. For the two workspace
 *    install targets that is the workspace anchor (`owner_level='workspace'`,
 *    `organization_id NULL`, `owner_id='__platform__'`), which is precisely what
 *    gives the row app-wide reach: the cross-org guard only fences rows that
 *    HAVE an owning org.
 *
 * The ownerId is normalized for the org-NULL tiers so the row satisfies the
 * platform-invariant CHECK (`installed_extension_platform_invariant_chk`) that
 * NAMES the `__platform__` sentinel, rather than depending on the canonical
 * store's downstream `platformizeOwnerId` normalization.
 */
export function resolveInstallRowAnchor(
  actorOrgId: string | null,
  planned?: InstallRowOwnership | null,
): InstallRowOwnership {
  if (!planned) return actorDerivedRowAnchor(actorOrgId);
  const organizationId = planned.organizationId ?? null;
  const ownerId =
    organizationId === null && planned.ownerLevel !== "user" && planned.ownerLevel !== "team"
      ? (planned.ownerId ?? PLATFORM_OWNER_SENTINEL)
      : (planned.ownerId ?? null);
  return { ownerLevel: planned.ownerLevel, ownerId, organizationId };
}

/**
 * Is this the app-wide WORKSPACE anchor (org-NULL)? The discriminator the write
 * path uses where a workspace-anchored row needs different handling from an
 * org-anchored one — notably the install action's rollback, which cannot route
 * an org-NULL row through the org-pinned lifecycle resolver (that is S4 #2698)
 * and takes the row-scoped inverse instead.
 */
export function isWorkspaceRowAnchor(anchor: InstallRowOwnership): boolean {
  return anchor.ownerLevel === "workspace" && (anchor.organizationId ?? null) === null;
}
