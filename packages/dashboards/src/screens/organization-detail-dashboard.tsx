/**
 * `/organizations/[id]` screen — the organization's entity page, opening on its
 * Dashboards tab (cinatra#705; the tab body rebuilt to the ratified drawing by
 * cinatra#2807 fix leg 3).
 *
 * WHAT THIS TAB DRAWS. The ratified drawing's Dashboards-tab section fixes it:
 * the caption "The dashboards in Organization: <name>." over the scope's rows —
 * homed and secondary-listed alike, with no relation badge — and, for a scope
 * manager only, "Add dashboard" at the right of that caption row (§IX.2:
 * "Suppression, not a disabled control").
 *
 * WHAT IT NO LONGER DRAWS, and why. This landing used to stack a dashboard
 * canvas above that panel: a toolbar band, an Overview selector, an Organization
 * details card and a members/teams counts card. The section names none of them,
 * and it sends identity and membership somewhere else in its own words — the
 * Settings entry is "that entity's management pane, where rename, visibility and
 * the members / access section live folded together". The Components Toolbar
 * rule also forbids the band's placement outright ("never stack a toolbar and
 * the etched paired rule"). So the tab body is the section's body and nothing
 * else; each dashboard is opened at its canonical surface.
 *
 * Authz (fail closed): the redirect gate uses the session SecurityContext, then
 * nothing about the org is read until `readUserIsOrgMember` confirms the viewer
 * is a member of THIS org. A non-member (or a deleted org) is a 404, never a
 * widened surface.
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
import { buildScopeCatalogNode } from "@/components/dashboards/scope-catalog-node";
import {
  getActorContext,
  getAuthSession,
  signInRedirectTarget,
} from "@/lib/auth-session";
import { CrumbContributions } from "@/components/crumb-contributions";
import {
  betterAuthDb,
  betterAuthOrganizations,
  readUserIsOrgMember,
} from "@/lib/better-auth-db";

import { buildSecurityContextFromSession } from "../auth/security-context";

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

  // Fail-closed access gate: only a member of THIS org may see its identity.
  const isMember = await readUserIsOrgMember(userId, id);
  if (!isMember) {
    notFound();
  }

  // Access-scoped read — the membership gate above authorizes it.
  const orgRows = await betterAuthDb
    .select({
      name: betterAuthOrganizations.name,
      // cinatra#1942 V4 — threaded through for the "Archived — read-only"
      // banner below; reads `archivedAt` directly, never the archive
      // activation gate.
      archivedAt: betterAuthOrganizations.archivedAt,
    })
    .from(betterAuthOrganizations)
    .where(eq(betterAuthOrganizations.id, id))
    .limit(1);

  const org = orgRows[0];
  if (!org) {
    // The membership row referenced an org that no longer exists.
    notFound();
  }

  const orgName = org.name ?? "";
  const isArchived = org.archivedAt !== null;

  // ACTIVE-TENANT FENCE — this is the retired collection route's own gate,
  // preserved exactly. `readUserIsOrgMember` above admits a member of ANY of
  // their orgs, active or not; the collection read must not be wider than the
  // route it replaced, so the panel is suppressed (not redirected) outside the
  // active tenant, keeping the landing reachable for every member.
  const actor = await getActorContext();
  const actorIsActiveInThisOrg = actor?.organizationId === id;
  const scope = { kind: "organization", scopeId: id, orgId: id } as const;

  // The add-to-scope source for the unified Add-dashboard popup. It is `null`
  // for anyone who may not write this scope (§IX.2 suppression), and it rides
  // the SAME active-tenant fence the panel rides.
  const scopeReference =
    actor && actorIsActiveInThisOrg
      ? buildScopeReferenceSource(actor, scope)
      : null;
  const scopeLabel = `Organization: ${orgName || id}`;

  const catalog =
    actor && actorIsActiveInThisOrg
      ? await buildScopeCatalogNode({
          actor,
          surface: { kind: "organization", orgId: id, scopeId: id, userId },
        })
      : null;

  // NOTE (fix leg 3, convergence round): the popup's create and installed-catalog
  // paths are NOT wired from this landing. Both write a row owned by the acting
  // user, and this tab reads the SCOPE's collection, so a copy made through them
  // would report success and then appear nowhere here. The drawn Add is the
  // add-to-scope picker; where the other two belong is recorded on the pull
  // request for the maintainer.

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
        {/* The entity-page tablist: this landing IS the Dashboards tab, and
            Settings is appended last. Rendered for every member — the settings
            page owns the read-only/manage split. */}
        <EntityScopeTabs
          dashboardsHref={`/organizations/${encodeURIComponent(id)}`}
          assistantsHref={`/organizations/${encodeURIComponent(id)}/assistants`}
          agentsHref={`/organizations/${encodeURIComponent(id)}/agents`}
          artifactsHref={`/organizations/${encodeURIComponent(id)}/artifacts`}
          skillsHref={`/organizations/${encodeURIComponent(id)}/skills`}
          settingsHref={`/organizations/${encodeURIComponent(id)}/settings`}
          active="dashboards"
        />
        {/* cinatra#1942 V4 — "Archived — read-only" banner. */}
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

        {/* The Dashboards tab body. The provider hands the Add affordance its
            sources; what crosses is server-bound actions and a label, never the
            actor or the scope's owner axis. */}
        {actor && actorIsActiveInThisOrg ? (
          <ScopeAddSourcesProvider
            scopeLabel={scopeLabel}
            reference={scopeReference}
            catalog={catalog}
          >
            <ScopeDashboardsSection
              actor={actor}
              scope={scope}
              entityLabel={scopeLabel}
            />
          </ScopeAddSourcesProvider>
        ) : null}
      </PageContent>
    </Main>
  );
}
