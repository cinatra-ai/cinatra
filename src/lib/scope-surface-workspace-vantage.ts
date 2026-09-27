import "server-only";
/**
 * THE LIVE BINDING of #2808’s `WorkspaceVantage` builder (cinatra#2810,
 * per-scope surfaces S4).
 *
 * The acceptance sentence this module serves, verbatim:
 *
 *   "the workspace page lists the union over the epic’s normative
 *    `WorkspaceVantage` (see #2806; builder owned by #2808, consumed here)"
 *
 * #2808 owns the builder; this module is the other half of that contract — the
 * one place the platform’s real reads are bound to it, for the surfaces that
 * consume the vantage. The builder is consumed EXACTLY as that slice ships it:
 * not re-implemented, not re-composed, not wrapped in a second rule. Everything
 * below is a read binding.
 *
 * ARCHIVAL sits on the READ side of the split, exactly as the vantage’s own
 * contract puts it: "Archival removes the organization on the next read,
 * exactly like a revoked membership". `readOrgsWithTeamsForUserActiveOnly`
 * answers the membership question the vantage is defined by — every
 * non-archived organization for which the actor holds a current member row — so
 * an archived organization never enters a vantage at all.
 *
 * ORGANIZATION-INDEPENDENT BY CONSTRUCTION. `activeOrganizationId` is not part
 * of the vantage, so nothing here consults it. The workspace tab’s read
 * therefore has no active organization in it to be missing, which is what lets
 * that tab decline the `/artifacts` active-org redirect without losing its
 * contents.
 */
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { buildWorkspaceVantage, type WorkspaceVantage } from "@/lib/scope-surface-vantage";

/**
 * The actor’s workspace vantage, built by #2808’s exported builder over the live
 * reads.
 *
 * The three axes are read the way the per-scope eligibility reader reads them:
 * the active-only organizations-with-teams read serves the membership and team
 * axes from one query per actor, and the actor-visible project reader serves
 * the project axis per organization. The workspace union decides on all three,
 * so all three are populated here.
 *
 * Fails CLOSED: a read that throws yields a vantage with no member organization
 * rather than a broader one. A workspace tab then shows the actor’s own rows and
 * the workspace tier and nothing else, which is a smaller truth — never a
 * larger one.
 */
export async function readWorkspaceVantage(userId: string): Promise<WorkspaceVantage> {
  try {
    const orgs = await readOrgsWithTeamsForUserActiveOnly(userId);
    const teamIdsByOrg: Record<string, string[]> = {};
    const projectIdsByOrg: Record<string, string[]> = {};
    for (const org of orgs) {
      teamIdsByOrg[org.id] = org.teams.map((team) => team.id);
      // The actor-visible project reader, per organization — never every
      // project in the tenant.
      projectIdsByOrg[org.id] = (await readProjectsForUser(userId, org.id)).map(
        (project) => project.id,
      );
    }
    return buildWorkspaceVantage({
      userId,
      memberships: orgs.map((org) => ({ orgId: org.id })),
      teamIdsByOrg,
      projectIdsByOrg,
    });
  } catch {
    return { userId, organizations: [] };
  }
}
