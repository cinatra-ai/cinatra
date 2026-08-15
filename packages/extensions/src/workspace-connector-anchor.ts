// ---------------------------------------------------------------------------
// The WORKSPACE-ANCHORED ROW predicate + identity (cinatra#2694 / S3 #2697).
//
// S1 (#2695) declared the target→ownership contract and S2 (#2696) made the
// write path persist it, so a "Workspace: All" / "Workspace: Admins only"
// install now lands a canonical row at the WORKSPACE ANCHOR:
//
//     owner_level = 'workspace'   organization_id IS NULL   owner_id = '__platform__'
//
// S3 is the READ half — the connector substrate. Four seams have to recognize
// that exact shape (the install chokepoint, the two canonical connector-access
// resolvers, and the runtime card record's trust-anchor + discovery path), so
// the recognition rule lives HERE once instead of being re-spelled four times:
// a re-spelling that drifted would either fence the workspace row out of one
// surface or admit a shape the DB's platform-invariant CHECK refuses.
//
// PURE (no IO, no server-only) so every seam — including the sync connector
// resolver and the pure row picks — can import it.
// ---------------------------------------------------------------------------

import { PLATFORM_OWNER_SENTINEL } from "./canonical-types";
import { WORKSPACE_ANCHOR_ROW_OWNERSHIP } from "./install-access-target";

/** The row/tuple fields the anchor predicate reads (DI-friendly, kind-agnostic). */
export type WorkspaceAnchorRowView = {
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
};

/**
 * Is this row/tuple the PRODUCT-INSTALLED workspace anchor — the exact S1
 * contract tuple ({@link WORKSPACE_ANCHOR_ROW_OWNERSHIP})?
 *
 * `ownerId` is accepted as `null` OR the `__platform__` sentinel because the
 * canonical store platformizes a null owner at this tier on write
 * (`platformizeOwnerId`), so both spellings denote the same persisted row. Any
 * OTHER ownerId is refused: the DB's platform-invariant CHECK names the
 * sentinel for an org-NULL row, so a workspace row "owned" by something else is
 * not a shape that can exist — never a shape a read seam should honor.
 *
 * DELIBERATELY NARROW: `owner_level='platform'` is NOT this anchor. Platform
 * rows are the bundled/system tier (the boot seeder's static-bundle anchors and
 * tombstones), whose path S3 leaves exactly as it is.
 */
export function isWorkspaceAnchoredRow(row: WorkspaceAnchorRowView): boolean {
  return (
    row.ownerLevel === WORKSPACE_ANCHOR_ROW_OWNERSHIP.ownerLevel &&
    (row.organizationId ?? null) === null &&
    (row.ownerId === null || row.ownerId === PLATFORM_OWNER_SENTINEL)
  );
}

/**
 * The canonical IDENTITY a workspace-anchored row for `packageName` reads back
 * at — `(organization_id NULL, owner_level 'workspace', owner_id '__platform__',
 * package_name)`. The WORKSPACE-FALLBACK arm of the org-first resolution passes
 * this to `readInstalledExtensionByIdentity`, so the fallback key can never
 * drift from the anchor the write path persists.
 */
export function workspaceAnchorIdentity(packageName: string): {
  organizationId: null;
  ownerLevel: "workspace";
  ownerId: string;
  packageName: string;
} {
  return {
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: PLATFORM_OWNER_SENTINEL,
    packageName,
  };
}
