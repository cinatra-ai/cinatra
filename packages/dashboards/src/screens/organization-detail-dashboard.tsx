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
import { eq, sql } from "drizzle-orm";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
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

import { resolveOrganizationManageCapabilities } from "@/lib/authz/organization-manage-gate";
import {
  countOrganizationDeleteBlockers,
  type OrganizationDeleteBlockers,
} from "@/lib/organization-delete";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { OrganizationDetailTabs } from "../components/organization-detail-tabs";
import { OrganizationPermissionsPanel } from "../components/organization-permissions-panel";
import { OrganizationManagePanel } from "../components/organization-manage-panel";
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
  buildOrganizationManageMembers,
  normalizePendingInvitation,
  type OrganizationPendingInvitation,
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
  const accessModel = buildOrganizationAccessModel(memberRows, teams);

  // Viewed-org management capabilities (cinatra#1510): resolve the caller's
  // role in THIS org and map it through the real catalog. A read-only member
  // (or a platform admin who is not a member here) gets no capabilities and no
  // Manage tab. `canManageSettings` (org_admin+) gates the tab; the member
  // console inside is further gated on `canManageMembers` (org_owner).
  const manage = await resolveOrganizationManageCapabilities(session, id);

  // Pending invitations are only read for an owner who can act on them; keep
  // fail-closed (a read error degrades to an empty list, never a broken tab).
  let pendingInvitations: readonly OrganizationPendingInvitation[] = [];
  if (manage.canManageMembers) {
    try {
      const invitationRows = await betterAuthDb.execute<{
        id: string;
        email: string | null;
        role: string | null;
      }>(sql`
        SELECT id, email, role
        FROM public."invitation"
        WHERE "organizationId" = ${id} AND status = 'pending'
        ORDER BY email ASC
      `);
      pendingInvitations = invitationRows.rows.map(normalizePendingInvitation);
    } catch {
      pendingInvitations = [];
    }
  }

  // Danger-zone pre-count (cinatra#1510 remainder): only a viewer whose
  // capabilities carry `canDelete` pays the count query. Advisory for the UI —
  // the delete transaction re-counts under the org-row lock. Fail-closed: an
  // unreadable count hides the card rather than rendering an unverified one.
  let deleteBlockers: OrganizationDeleteBlockers | undefined;
  if (manage.canDelete) {
    try {
      deleteBlockers = await countOrganizationDeleteBlockers(id);
    } catch {
      deleteBlockers = undefined;
    }
  }

  const manageSlot = manage.canManageSettings ? (
    <OrganizationManagePanel
      organizationId={id}
      orgName={orgName}
      currentSlug={org.slug ?? ""}
      currentUserId={userId}
      canManageSettings={manage.canManageSettings}
      canManageMembers={manage.canManageMembers}
      canDelete={manage.canDelete && deleteBlockers !== undefined}
      deleteBlockers={deleteBlockers}
      members={buildOrganizationManageMembers(memberRows)}
      invitations={pendingInvitations}
    />
  ) : undefined;

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
          manageSlot={manageSlot}
        />
      </PageContent>
    </Main>
  );
}
