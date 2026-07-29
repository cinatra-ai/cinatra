/**
 * `/organizations/[id]` screen — per-org detail surface (cinatra#705, epic
 * #699; tabless since #1734, the #1693 ruling: the detail page keeps only the
 * dashboards).
 *
 *   - The reusable entity Dashboards shell (#701) bound to this org's
 *     per-user dashboard set, with the non-removable **Overview** default
 *     rendering the org's identity + member/team counts as portlets (#702)
 *     and a "+ New dashboard" / select toolbar.
 *   - The access model + management (settings, members & invitations, danger
 *     zone) live on `/organizations/[id]/settings`, linked from the header —
 *     the button is visible to EVERY member (the settings page itself splits
 *     read-only vs manage, exactly as the retired tabs did).
 *
 * Authz (fail closed): the redirect gate uses the session SecurityContext, then
 * the org identity + counts are only read AFTER `readUserIsOrgMember` confirms
 * the viewer is a member of THIS org — the Overview data is fetched
 * outside the cube, so this surface enforces the same "member of the org" rule
 * the cube predicate (`WHERE id IN (accessibleOrgIds)`) applies to the analytics
 * path. A non-member (or a deleted org) is a 404, never a widened surface.
 */
import "server-only";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Settings } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { getAuthSession } from "@/lib/auth-session";
import { CrumbContributions } from "@/components/crumb-contributions";
import {
  betterAuthDb,
  betterAuthMembers,
  betterAuthOrganizations,
  betterAuthUsers,
  listTeamsForOrg,
  readUserIsOrgMember,
} from "@/lib/better-auth-db";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { OrganizationDashboards } from "../components/organization-dashboards";
import { buildOrganizationOverviewConfig } from "../components/seed-configs/overview-config";
import type { EntityDashboardsDataSource } from "../entity-dashboards-contract";
import {
  createOrganizationDashboardAction,
  deleteOrganizationDashboardAction,
  ensureAndListOrganizationDashboardsAction,
  getOrganizationDashboardConfigAction,
  renameOrganizationDashboardAction,
  saveOrganizationDashboardConfigAction,
} from "./organization-detail-actions";
import {
  buildOrganizationAccessModel,
  buildOrganizationDetailRef,
} from "./organization-detail-model";

export async function OrganizationDetailDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }
  const userId = ctx.userId;

  // Fail-closed access gate: only a member of THIS org may see its identity,
  // counts, and access model (all read outside the cube's own predicate).
  const isMember = await readUserIsOrgMember(userId, id);
  if (!isMember) {
    notFound();
  }

  // Access-scoped reads — the membership gate above authorizes them.
  const [orgRows, memberRows, teams] = await Promise.all([
    betterAuthDb
      .select({
        name: betterAuthOrganizations.name,
        slug: betterAuthOrganizations.slug,
        // cinatra#1942 V4 — threaded through for the "Archived — read-only"
        // banner below; reads `archivedAt` directly, never the archive
        // activation gate (visibility surfaces are gate-blind by design:
        // with the gate off no org has archivedAt set, so they are inert
        // without needing a second switch).
        archivedAt: betterAuthOrganizations.archivedAt,
      })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, id))
      .limit(1),
    betterAuthDb
      .select({
        id: betterAuthMembers.id,
        userId: betterAuthMembers.userId,
        role: betterAuthMembers.role,
        name: betterAuthUsers.name,
        email: betterAuthUsers.email,
      })
      .from(betterAuthMembers)
      .leftJoin(betterAuthUsers, eq(betterAuthUsers.id, betterAuthMembers.userId))
      .where(eq(betterAuthMembers.organizationId, id)),
    listTeamsForOrg(id),
  ]);

  const org = orgRows[0];
  if (!org) {
    // The membership row referenced an org that no longer exists.
    notFound();
  }

  const orgName = org.name ?? "";
  // cinatra#1942 V4 — read-only posture: an archived org's dashboards stay
  // viewable but the surface is presented as read-only chrome (the banner
  // below); no write path on this screen is gated on it (there is none —
  // the Dashboards surface here has no org-mutating actions).
  const isArchived = org.archivedAt !== null;
  // Access model retained ONLY for its counts (Overview portlets) — the full
  // view + management moved to /organizations/[id]/settings (#1734).
  const accessModel = buildOrganizationAccessModel(memberRows, teams);

  // The Overview is EPHEMERAL: built fresh here from the just-fetched counts and
  // handed to the shell's render seam, never persisted (render-only portlets).
  const overviewConfig = buildOrganizationOverviewConfig({
    name: orgName,
    ...(org.slug ? { slug: org.slug } : {}),
    memberCount: accessModel.memberCount,
    teamCount: accessModel.teamCount,
  });

  // Bind the generic entity-dashboards actions with this surface's
  // server-derived ref (Next-encrypted across the boundary; the client shell
  // never authors the owner axis).
  const ref = buildOrganizationDetailRef(id, userId);
  const dataSource: EntityDashboardsDataSource = {
    listDashboards: ensureAndListOrganizationDashboardsAction.bind(null, ref),
    loadConfig: getOrganizationDashboardConfigAction.bind(null, ref),
    createDashboard: createOrganizationDashboardAction.bind(null, ref),
    renameDashboard: renameOrganizationDashboardAction.bind(null, ref),
    deleteDashboard: deleteOrganizationDashboardAction.bind(null, ref),
    saveDashboard: saveOrganizationDashboardConfigAction.bind(null, ref),
  };

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): the membership gate above
          passed. Pre-Stage-C an org may still have a NULL name — fall back to
          the short-id placeholder explicitly (never title-cased hex). */}
      <CrumbContributions
        entries={[
          {
            prefix: `/organizations/${encodeURIComponent(id)}`,
            label: orgName || `${id.slice(0, 8)}…`,
          },
        ]}
      />
      <PageHeader
        title={orgName || "Organization"}
        description="Dashboards for this organization."
        divider={false}
        actions={
          <div className="flex items-center gap-2">
            {isArchived ? <LifecycleBadge status="archived" /> : null}
            <Button asChild variant="outline">
              <Link href={`/organizations/${encodeURIComponent(id)}/settings`}>
                <Settings data-icon="inline-start" aria-hidden="true" />
                Organization settings
              </Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* cinatra#1942 V4 — "Archived — read-only" banner.
            Reads `archivedAt` directly, never the activation gate. The copy
            deliberately claims read-only for the ORG's settings/membership
            only — the viewer's own dashboards ABOUT the org (per-user rows,
            not org data) stay editable, so the banner must not overclaim. */}
        {isArchived ? (
          <div
            data-cinatra-archived-banner="true"
            className="soft-panel border-line bg-surface-muted px-4 py-3 text-xs text-muted-foreground"
          >
            <p className="font-medium text-foreground">Archived — read-only</p>
            <p>
              This organization is archived. Its settings and membership
              can&apos;t be changed until it&apos;s unarchived.
            </p>
          </div>
        ) : null}

        <OrganizationDashboards
          dataSource={dataSource}
          overviewPortlets={overviewConfig.portlets}
        />
      </PageContent>
    </Main>
  );
}
