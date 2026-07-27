import "server-only";
/**
 * `/agents/reviews` — the organization's OPEN REVIEW QUEUE (cinatra#2047 row 9).
 *
 * The acceptance found that the only gate listing that shipped was
 * `listReviewGatesForRun` — strictly run-scoped. A reviewer could therefore see a
 * review only by already standing on the run that produced it: there was no way to
 * ask "how many reviews are open?", which is precisely the fatigue question row 9
 * exists to answer. This page is that answer for a REVIEWER (the admin's
 * survivability view of the same rollup lives beside the bounds it would tune, on
 * `/configuration/artifacts?tab=review-policy`).
 *
 * Reviewer-reachable, not admin-only: a plain org `member` holds both
 * `settings.read` (this read) and `run.approveHitl` (the decision), so gating this
 * behind the admin console would have hidden the backlog from exactly the people
 * who work it.
 *
 * TWO DIFFERENT DISCLOSURE LEVELS, DELIBERATELY:
 *
 *   - The COUNTS are org-wide aggregates. "17 reviews open, 4 of them over a week
 *     old" names no run and no artifact; it is the volume signal itself.
 *   - The LISTING names runs. Run existence is protected — `enforceReviewRunAccess`
 *     answers a foreign run with a 404-shaped denial precisely so a run id cannot
 *     be probed — so every listed row is RE-CHECKED against the viewer's run READ
 *     access before it is rendered. Deep-link re-authorization alone would be too
 *     late: it protects the content, but not the existence this page would already
 *     have disclosed.
 *
 * Navigation + volume only: no decision affordance ships here, and the deep-link
 * target re-authorizes per gate, so appearing in this list never implies the
 * viewer may decide it.
 */
import type { Metadata } from "next";

import {
  readOrgReviewGateVolume,
  type OpenReviewGateRow,
} from "@cinatra-ai/agents/lifecycle-policy-store";
import { enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { AgentsTabNav } from "@/components/agents-tab-nav";
import { GateVolumePanel } from "@/components/artifacts/console/gate-volume-panel";
import {
  lifecycleAccessMessage,
  resolveGateVolumeReadAccess,
} from "@/lib/artifacts/lifecycle-policy-access";
import { getAuthSession, getActorContext } from "@/lib/auth-session";
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";

export const metadata: Metadata = { title: "Agents · Reviews" };
// Per-viewer + org-scoped, session-derived — never statically cached.
export const dynamic = "force-dynamic";

/**
 * Keep only the rows whose RUN the viewer may read. Bounded by the listing size
 * (25 by default), and fail-closed: any resolution error drops the row rather
 * than disclosing it. A viewer with no resolvable actor sees no rows at all.
 */
async function filterByRunAccess(rows: OpenReviewGateRow[]): Promise<OpenReviewGateRow[]> {
  if (rows.length === 0) return [];
  const session = await getAuthSession();
  const kernel = await getActorContext();
  if (!session || !kernel) return [];

  // The SAME actor + role-hint shape the review surface itself enforces with
  // (`review-actor.ts`), so a row this page shows is a row that surface will
  // admit — a reviewer granted run access through an org role, a team or a
  // project is recognized here too, not falsely dropped.
  const actor = actorFromSession(session);
  const roleHints: ActorRoleHints = {
    ...(kernel.platformRole ? { platformRole: kernel.platformRole } : {}),
    ...(kernel.orgRole ? { orgRole: kernel.orgRole } : {}),
    ...(kernel.teamRoles ? { teamRoles: kernel.teamRoles } : {}),
    ...(kernel.teamIds ? { teamIds: kernel.teamIds } : {}),
    ...(kernel.projectGrants ? { projectGrants: kernel.projectGrants } : {}),
    ...(kernel.organizationId ? { actorOrganizationId: kernel.organizationId } : {}),
  };

  const verdicts = await Promise.all(
    rows.map(async (row) => {
      try {
        const access = await enforceReviewRunAccess(row.runId, actor, "read", roleHints);
        return access.ok;
      } catch {
        return false;
      }
    }),
  );
  return rows.filter((_, i) => verdicts[i]);
}

export default async function AgentReviewsPage() {
  const access = await resolveGateVolumeReadAccess();
  const volume = access.ok ? await readOrgReviewGateVolume({ orgId: access.orgId }) : null;
  const visible = volume ? await filterByRunAccess(volume.openGates) : [];

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Reviews"
        description="How much artifact review this organization has open, and the oldest of it you can act on."
        divider={false}
      />
      <AgentsTabNav activeTab="reviews" />
      <PageContent className="flex flex-col gap-4 pb-8">
        {volume ? (
          <GateVolumePanel volume={{ ...volume, openGates: visible }} listingCap />
        ) : (
          <div
            className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
            data-testid="gate-volume"
            data-state="denied"
          >
            {lifecycleAccessMessage(access.ok ? "forbidden" : access.reason)}
          </div>
        )}
      </PageContent>
    </Main>
  );
}
