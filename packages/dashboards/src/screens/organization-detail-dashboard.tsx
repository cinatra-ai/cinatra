/**
 * `/organizations/[id]` screen — per-org detail surface (cinatra#705, epic #699).
 *
 * A tablist mirroring the other entity detail surfaces:
 *   - **Dashboards** — the reusable entity Dashboards shell (#701) bound to this
 *     org's per-user dashboard set, with the non-removable **Overview** default
 *     rendering the org's identity + member/team counts as portlets (#702) and a
 *     "+ New dashboard" / select toolbar.
 *   - **Permissions** — the org's access MODEL (members by role + teams),
 *     read-only. Membership derives from the Better-Auth `member` table; org-wide
 *     management lives at `/configuration/workspace`; no customer invite.
 *
 * Authz (fail closed): the redirect gate uses the session SecurityContext, then
 * the org identity + counts are only read AFTER `readUserIsOrgMember` confirms
 * the viewer is a member of THIS org — the Overview/Permissions data is fetched
 * outside the cube, so this surface enforces the same "member of the org" rule
 * the cube predicate (`WHERE id IN (accessibleOrgIds)`) applies to the analytics
 * path. A non-member (or a deleted org) is a 404, never a widened surface.
 */
import "server-only";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { getAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthMembers,
  betterAuthOrganizations,
  betterAuthUsers,
  listTeamsForOrg,
  readUserIsOrgMember,
} from "@/lib/better-auth-db";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { OrganizationDetailTabs } from "../components/organization-detail-tabs";
import { OrganizationPermissionsPanel } from "../components/organization-permissions-panel";
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
      })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, id))
      .limit(1),
    betterAuthDb
      .select({
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
      <PageHeader
        title={orgName || "Organization"}
        description="Dashboards and access for this organization."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <OrganizationDetailTabs
          dataSource={dataSource}
          overviewPortlets={overviewConfig.portlets}
          permissionsSlot={
            <OrganizationPermissionsPanel
              orgName={orgName}
              accessModel={accessModel}
            />
          }
        />
      </PageContent>
    </Main>
  );
}
