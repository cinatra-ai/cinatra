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

  // ACTIVE-TENANT FENCE, narrowed to the WRITE path (cinatra#2807 fix leg 5).
  //
  // This fence came over from the retired `/organizations/[id]/dashboards`
  // route, which refused any request whose target org was not the session's
  // ACTIVE org, and cinatra#2474 PR2 wrapped the WHOLE folded panel in it. The
  // fourth proof round graded what that costs: a member viewing an org that is
  // not their active one gets no Dashboards tab body at all — no caption, no
  // empty reading, no Add — where personal, team, project and the workspace all
  // draw one.
  //
  // The drawing rules the read universal and gates only management: "A member
  // without write authority still sees the Dashboards tab and every row —
  // homed and listed alike — and opens any of them; they simply get no Add
  // affordance and no Remove control. Suppression, not a disabled control: a
  // management action the member cannot take is not rendered."
  //
  // So the fence now covers exactly the two things that BIND a mutation to the
  // ambient tenant — the §IX.1 add-to-scope source and the installed-catalog
  // node — and no longer covers the read. The read is keyed on the VIEWED org's
  // own id (never the session's active org) and only runs after
  // `readUserIsOrgMember` above confirmed membership of THIS org.
  //
  // REMOVE IS FENCED EXPLICITLY, not by assumption (convergence round). An
  // earlier draft of this comment claimed `actorMayWriteScope` kept Remove
  // suppressed out here "in its own right". It does not: its first arm is
  // `if (actor.platformRole === "platform_admin") return true`, ahead of every
  // tenant check, so a platform admin viewing a member org that is not their
  // active one would have had `canRemove` true on every listed row — an
  // affordance this landing never offered before, because the whole panel used
  // to be withheld. So the mount passes `allowRemoval` and withholds the
  // removal source outside the active tenant: the READ widens (which is the
  // drawing's rule), the WRITE surface does not.
  const actor = await getActorContext();
  const actorIsActiveInThisOrg = actor?.organizationId === id;
  const scope = { kind: "organization", scopeId: id, orgId: id } as const;

  // The add-to-scope source for the unified Add-dashboard popup. It is `null`
  // for anyone who may not write this scope (§IX.2 suppression), and it keeps
  // the active-tenant fence: the Add is where the widening risk lives.
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

        {/* The Dashboards tab body, drawn for every confirmed member of this
            organization — the caption "The dashboards in Organization: <name>.",
            the scope's rows, and the drawn empty reading. The provider hands the
            Add affordance its sources; what crosses is server-bound actions and
            a label, never the actor or the scope's owner axis. Outside the
            active tenant those sources are `null`, so the Add is simply absent
            (§IX.2 suppression) while the read still draws. */}
        {actor ? (
          <ScopeAddSourcesProvider
            scopeLabel={scopeLabel}
            reference={scopeReference}
            catalog={catalog}
          >
            <ScopeDashboardsSection
              actor={actor}
              scope={scope}
              entityLabel={scopeLabel}
              allowRemoval={actorIsActiveInThisOrg}
            />
          </ScopeAddSourcesProvider>
        ) : null}
      </PageContent>
    </Main>
  );
}
