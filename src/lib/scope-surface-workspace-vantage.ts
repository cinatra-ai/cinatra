import "server-only";
/**
 * THE LIVE BINDING of #2808's `WorkspaceVantage` builder (cinatra#2810,
 * per-scope surfaces S4).
 *
 * The acceptance sentence this module serves, verbatim:
 *
 *   "the workspace page lists the union over the epic's normative
 *    `WorkspaceVantage` (see #2806; builder owned by #2808, consumed here)"
 *
 * #2808 owns the builder and deliberately INJECTS its three reads, so that a
 * conformance fixture can drive membership revocation, archival and an
 * active-org switch without a session. This module is the other half of that
 * contract: the one place the injected reads are bound to the platform's real
 * ones, for the surfaces that consume the vantage.
 *
 * The builder itself is consumed EXACTLY as that slice ships it — not
 * re-implemented, not re-composed, not wrapped in a second rule. Everything
 * below is a read binding.
 *
 * ORGANIZATION-INDEPENDENT BY CONSTRUCTION. `activeOrganizationId` is not part
 * of the vantage — the builder accepts one and ignores it — so nothing here
 * consults it either. The workspace tab's read therefore has no active
 * organization in it to be missing, which is what lets that tab decline the
 * `/artifacts` active-org redirect without losing its contents.
 */
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import {
  buildWorkspaceVantage,
  type WorkspaceVantage,
  type WorkspaceVantageDeps,
} from "@/lib/scope-surface-eligibility";

/**
 * The platform's own reads, in the shape the builder injects.
 *
 * `readOrgsWithTeamsForUserActiveOnly` already answers the membership question
 * the vantage is defined by — "every non-archived organization for which the
 * actor has a current `public.member` row" — and carries that organization's
 * visible teams in the same read, so the teams arm is served from the value
 * already in hand rather than by a second query per organization.
 */
export function workspaceVantageDeps(): WorkspaceVantageDeps {
  // One read per actor, shared by the membership and teams arms. The builder
  // calls `readMemberOrganizations` first and `readVisibleTeams` once per
  // organization it returns, so this is populated before any teams arm runs.
  let cached: Awaited<ReturnType<typeof readOrgsWithTeamsForUserActiveOnly>> | null = null;
  const orgsFor = async (userId: string) => {
    if (cached === null) cached = await readOrgsWithTeamsForUserActiveOnly(userId);
    return cached;
  };
  return {
    readMemberOrganizations: async (userId) =>
      (await orgsFor(userId)).map((org) => ({ orgId: org.id })),
    readVisibleTeams: async (userId, orgId) => {
      const org = (await orgsFor(userId)).find((candidate) => candidate.id === orgId);
      return (org?.teams ?? []).map((team) => team.id);
    },
    readVisibleProjects: async (userId, orgId) =>
      (await readProjectsForUser(userId, orgId)).map((project) => project.id),
  };
}

/**
 * The actor's workspace vantage, built by #2808's exported builder over the
 * live reads.
 *
 * Fails CLOSED: a read that throws yields a vantage with no member
 * organization rather than a broader one. A workspace tab then shows the
 * actor's own rows and the workspace tier and nothing else, which is a smaller
 * truth — never a larger one.
 */
export async function readWorkspaceVantage(userId: string): Promise<WorkspaceVantage> {
  try {
    return await buildWorkspaceVantage(workspaceVantageDeps(), { userId });
  } catch {
    return { userId, organizations: [] };
  }
}
