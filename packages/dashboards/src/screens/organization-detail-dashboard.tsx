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
 *     zone) live on `/organizations/[id]/settings`, reached from this page's
 *     **Settings tab** (cinatra#2474 PR1: the entity-page tablist replaces the
 *     former top-right settings button). The tab is rendered for EVERY member,
 *     outside any capability branch — the settings page itself splits read-only
 *     vs manage, exactly as the retired tabs did.
 *
 * Authz (fail closed): the redirect gate uses the session SecurityContext, then
 * the org identity + counts are only read AFTER `readUserIsOrgMember` confirms
 * the viewer is a member of THIS org — the Overview data is fetched
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
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";
import { ScopeAddSourcesProvider } from "@/components/dashboards/scope-add-sources";
import { buildScopeReferenceSource } from "@/components/dashboards/scope-reference-binding";
import {
  getActorContext,
  getAuthSession,
  signInRedirectTarget,
} from "@/lib/auth-session";
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
    redirect(await signInRedirectTarget());
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

  // The #1897 scope collection folded onto this landing (cinatra#2474 PR2).
  //
  // ACTIVE-TENANT FENCE — this is the retired route's own gate, preserved
  // exactly. `/organizations/[id]/dashboards` refused any request where the
  // target org was not the session's ACTIVE org (`activeOrgId !== id ||
  // actor.organizationId !== id -> redirect`). This landing is deliberately
  // wider than that: `readUserIsOrgMember` above admits a member of ANY of their
  // orgs, active or not. So the panel must re-apply the fence, or folding the
  // collection here would WIDEN the read — a member of orgs A and B, active in
  // A, visiting /organizations/B would newly read B's collection
  // (`getScopeDashboardsTabData` authorizes nothing itself; it reads whatever
  // `scope.orgId` it is handed), and a platform admin in that position could
  // even mutate it (platform_admin bypasses both the predicate's and the server
  // actions' tenant fences). #2474 is presentation-only — no read may widen.
  // Suppressing the panel, rather than redirecting, keeps the landing itself
  // reachable for every member exactly as PR1 left it (codex convergence).
  const actor = await getActorContext();
  const actorIsActiveInThisOrg = actor?.organizationId === id;
  const scope = { kind: "organization", scopeId: id, orgId: id } as const;

  // The §IX.1 add-to-scope source for the unified Add-dashboard popup
  // (cinatra#2474 PR3). It is `null` for anyone who may not write this scope
  // (§IX.2 suppression), and it rides the SAME active-tenant fence as the panel:
  // an org the actor is merely a member of must not gain an add path either.
  const scopeReference =
    actor && actorIsActiveInThisOrg
      ? buildScopeReferenceSource(actor, scope)
      : null;
  const scopeLabel = `Organization: ${orgName || id}`;

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
        label="Organization"
        title={orgName || "Organization"}
        description="Dashboards for this organization."
        divider={false}
        actions={isArchived ? <LifecycleBadge status="archived" /> : undefined}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* The entity-page tablist (cinatra#2474 PR1, spec §IX): this landing IS
            the Dashboards tab; Settings is the second entry. Rendered for every
            member — the settings page owns the read-only/manage split. */}
        <EntityScopeTabs
          dashboardsHref={`/organizations/${encodeURIComponent(id)}`}
          settingsHref={`/organizations/${encodeURIComponent(id)}/settings`}
          active="dashboards"
        />
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

        {/* The unified Add-dashboard popup's sources (cinatra#2474 PR3). The
            popup is launched from the dashboards toolbar INSIDE the shell, so
            the provider wraps the shell; what crosses is server-bound actions
            and a label, never the actor or the scope's owner axis. */}
        <ScopeAddSourcesProvider
          scopeLabel={scopeLabel}
          reference={scopeReference}
        >
          <OrganizationDashboards
            dataSource={dataSource}
            overviewPortlets={overviewConfig.portlets}
          />
        </ScopeAddSourcesProvider>
        {/* The scope's own dashboards collection (#1897 §IX), folded onto this
            landing by cinatra#2474 PR2 — it used to live on the separate
            `/organizations/[id]/dashboards` route, which PR2 deletes outright
            (no redirect, no shim). Homed + secondary-listed rows, the
            add-to-scope picker, Remove and the promotion recourse all keep the
            #1897 service and components; only the mount point moved. The
            per-user shell above (its dropdown and the non-removable Overview) is
            untouched — a secondary listing is deliberately NOT unioned into that
            per-user list (#2474's converged model fact), which is exactly why it
            renders as its own panel here. */}
        {actor && actorIsActiveInThisOrg ? (
          <ScopeDashboardsSection actor={actor} scope={scope} />
        ) : null}
      </PageContent>
    </Main>
  );
}
