"use server";

import { getAuthSession } from "@/lib/auth-session";
import { listOrganizationsForUser } from "@/lib/better-auth-db";

export type SwitcherOrganizations = {
  /** The caller's member organizations, sorted case-insensitively by name. */
  organizations: Array<{ id: string; name: string }>;
  /**
   * The session's active organization id — reported only when it is present
   * in the membership-filtered list above; a stale active org (the user was
   * removed after it became active) surfaces as `null`, never echoed back.
   */
  activeOrganizationId: string | null;
};

/**
 * List the caller's member organizations for the sidebar organization
 * switcher popover (lazy tier — invoked on first open).
 *
 * Security contract: this action takes NO parameters. The user id is derived
 * exclusively from the server session, so nothing client-supplied is ever
 * accepted or validated away. Org switching itself does NOT go through this
 * module — it uses Better Auth's own `setActive` endpoint, which re-validates
 * target-org membership server-side.
 */
export async function listMemberOrganizations(): Promise<SwitcherOrganizations> {
  const session = await getAuthSession();
  if (!session) {
    return { organizations: [], activeOrganizationId: null };
  }
  // ONE batched membership JOIN (ids + names in a single statement) — the
  // same membership predicate as `listAccessibleOrgIdsForUser`. No N+1: this
  // runs on every first popover open across the product.
  const organizations = await listOrganizationsForUser(session.user.id);
  const sessionActiveOrgId = session.session?.activeOrganizationId ?? null;
  const activeOrganizationId =
    sessionActiveOrgId && organizations.some((org) => org.id === sessionActiveOrgId)
      ? sessionActiveOrgId
      : null;
  return { organizations, activeOrganizationId };
}
