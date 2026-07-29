/**
 * `/organizations/[id]/settings` screen — the single org-management surface
 * (cinatra#1734, applying the #1693 ruling; owner call on the issue:
 * "Settings"). Hosts, in order:
 *   - the read-only ACCESS MODEL view (members by role + teams) that used to
 *     be the detail page's Permissions tab — visible to EVERY org member,
 *     exactly the tab's audience; and
 *   - the management surface (#1510: org details, members & invitations,
 *     the #1928 delete Danger zone — and the future archive controls) —
 *     rendered only when the viewer holds manage capabilities, exactly the
 *     retired Manage tab's audience.
 *
 * Authz (fail closed): identical to the detail screen — session
 * SecurityContext → sign-in redirect, then `readUserIsOrgMember` before any
 * org data is read; a non-member (or a deleted org) is a 404.
 * Capability-gated loads (invitations, delete blockers) run ONLY after their
 * capability check, never speculatively.
 */
import "server-only";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
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

import { resolveOrganizationManageCapabilities } from "@/lib/authz/organization-manage-gate";
import {
  countOrganizationDeleteBlockers,
  type OrganizationDeleteBlockers,
} from "@/lib/organization-delete";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { OrganizationPermissionsPanel } from "../components/organization-permissions-panel";
import { OrganizationManagePanel } from "../components/organization-manage-panel";
import {
  buildOrganizationAccessModel,
  buildOrganizationManageMembers,
  normalizePendingInvitation,
  type OrganizationPendingInvitation,
} from "./organization-detail-model";

export async function OrganizationSettingsPage({
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

  // Fail-closed access gate: only a member of THIS org may see its identity
  // and access model (same rule as the detail screen).
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
        // cinatra#1942 V4 — threaded through for the archived badge + the
        // read-only posture on the manage panel below; reads `archivedAt`
        // directly, never the archive activation gate (visibility surfaces
        // are gate-blind by design).
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
    notFound();
  }

  const orgName = org.name ?? "";
  // cinatra#1942 V4 — read-only posture: while archived, the manage panel
  // below stops rendering the interactive Settings / Members forms in favor
  // of a disabled, read-only presentation (the UI affordance layer; the
  // SERVER ACTION rejection is a separate, later authority change).
  const isArchived = org.archivedAt !== null;
  const accessModel = buildOrganizationAccessModel(memberRows, teams);

  // Viewed-org management capabilities (cinatra#1510) — the single-source
  // gate; a read-only member gets no capabilities and sees only the access
  // model below.
  const manage = await resolveOrganizationManageCapabilities(session, id);

  // Pending invitations are only read for an owner who can act on them; keep
  // fail-closed (a read error degrades to an empty list, never a broken page).
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

  // Danger-zone pre-count: only a viewer whose capabilities carry `canDelete`
  // pays the count query. Fail-closed: an unreadable count hides the card.
  let deleteBlockers: OrganizationDeleteBlockers | undefined;
  if (manage.canDelete) {
    try {
      deleteBlockers = await countOrganizationDeleteBlockers(id);
    } catch {
      deleteBlockers = undefined;
    }
  }

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): resolves the intermediate
          org-id crumb (short-id floor for pre-Stage-C NULL names) AND pins the
          leaf to "Settings" (the teams settings pattern). */}
      <CrumbContributions
        entries={[
          {
            prefix: `/organizations/${encodeURIComponent(id)}`,
            label: orgName || `${id.slice(0, 8)}…`,
          },
          {
            prefix: `/organizations/${encodeURIComponent(id)}/settings`,
            label: "Settings",
          },
        ]}
      />
      <PageHeader
        label="Organization"
        title={orgName || "Organization"}
        description="Who has access to this organization, and its management controls."
        divider={false}
        actions={
          <div className="flex items-center gap-2">
            {isArchived ? <LifecycleBadge status="archived" /> : null}
            <Button asChild variant="outline">
              <Link href={`/organizations/${encodeURIComponent(id)}`}>
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                Back to organization
              </Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* The entity-page tablist: this Settings pane is the second tab (spec
            §IX); Dashboards is the first, at the sibling scope route. */}
        <EntityScopeTabs
          dashboardsHref={`/organizations/${encodeURIComponent(id)}/dashboards`}
          settingsHref={`/organizations/${encodeURIComponent(id)}/settings`}
          active="settings"
        />
        <OrganizationPermissionsPanel
          orgName={orgName}
          accessModel={accessModel}
          viewerCanManageMembers={manage.canManageMembers}
        />
        {manage.canManageSettings ? (
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
            isArchived={isArchived}
          />
        ) : null}
      </PageContent>
    </Main>
  );
}
