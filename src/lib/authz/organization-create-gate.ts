import { buildCanDoOptsFromSession } from "@/lib/auth-session";
import { canDo } from "@/lib/authz/enforce";
import { isSingleOrgMode } from "@/lib/authz/instance-mode";

/**
 * Structural subset of the Better Auth session this gate reads — kept in
 * lockstep with `canDo`'s session parameter (src/lib/authz/enforce.ts).
 */
type SessionLike = {
  user: { id: string; role?: string | null };
  session: { activeOrganizationId?: string | null };
};

/**
 * Shared UI/route gate for organization creation: single-org mode is off AND
 * the session actor holds `organization.create` (platform admins only, per
 * src/lib/authz/policies.ts). This is the SAME predicate `src/app/layout.tsx`
 * computes inline for the global `+` menu (`canCreateOrganizations`), shared
 * so the `/organizations` page action, the `/organizations/new` page, and
 * `createOrganizationAction` cannot drift from it.
 *
 * Failure modes mirror layout.tsx: an unreadable single-org toggle falls
 * through to the permission check (the default is multi-org — see the
 * matching fail-open note on `allowUserToCreateOrganization` in
 * src/lib/auth.ts), and an unresolvable org role degrades to no synthetic
 * org role.
 *
 * NOT the authoritative enforcement point: Better Auth's
 * `allowUserToCreateOrganization` (src/lib/auth.ts) re-runs the block inside
 * the create endpoint itself, for every caller.
 */
export async function userCanCreateOrganizations(
  session: SessionLike,
): Promise<boolean> {
  if (await isSingleOrgMode().catch(() => false)) {
    return false;
  }
  const canDoOpts = await buildCanDoOptsFromSession(session).catch(() => ({}));
  return canDo(session, "organization.create", undefined, canDoOpts);
}
