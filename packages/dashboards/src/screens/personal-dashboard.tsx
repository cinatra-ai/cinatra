/**
 * `/personal` screen — the user's own multi-dashboard surface (cinatra#703).
 *
 * The lowest-risk first integration of the epic's model (#699): `/personal`
 * moves from a single per-user dashboard (Edit/Save only) to the reusable
 * `<EntityDashboardsShell>` (#701) over the per-entity multi-dashboard data
 * model (#700), so the toolbar gains the "+ New dashboard" button and the
 * dashboard-select dropdown. The user can now keep multiple NAMED personal
 * dashboards, each persisted per-user.
 *
 * Personal specifics (per the issue):
 *   - No entity scoping — personal IS the user's own scope; the ref is USER-
 *     owned with the ambient org as `entityId` (see `buildPersonalEntityRef`).
 *   - No Permissions tab, no Overview renderer (#702): the personal Overview is
 *     just the user's private EMPTY dashboard — the same row the legacy single-id
 *     save wrote, absorbed as this entity's non-removable Overview by the #700
 *     backfill — so no entity-summary seed is passed to `ensure`.
 *   - Grid-only layout is preserved (the shell defaults to `["grid"]`); the
 *     `dashboard-modes` contract pins this screen to that default (no toggle).
 *
 * The Overview must exist BEFORE listing (the shell never ensures — #701), so we
 * ensure it here, then SSR-seed the shell with the Overview-inclusive list +
 * the selected Overview config to skip the first client round-trip. The data
 * source binds the server-derived personal ref into the generic entity actions
 * (`bindPersonalDashboardsDataSource`), so the ref crosses to the client shell
 * Next-encrypted and the client never authors the owner axis.
 */
import "server-only";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { ScopeAddSourcesProvider } from "@/components/dashboards/scope-add-sources";
import { buildScopeCatalogNode } from "@/components/dashboards/scope-catalog-node";

import { getActorContext, getAuthSession, signInRedirectTarget } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { EntityDashboardsShell } from "../components/entity-dashboards-shell";
import type { EntityDashboardsDataSource } from "../entity-dashboards-contract";
import {
  createEntityDashboardAction,
  deleteEntityDashboardAction,
  ensureEntityOverviewAction,
  getEntityDashboardConfigAction,
  listEntityDashboardsAction,
  renameEntityDashboardAction,
  saveEntityDashboardConfigAction,
} from "../actions";
import {
  bindPersonalDashboardsDataSource,
  buildPersonalEntityRef,
} from "./personal-dashboard-data-source";

export async function PersonalDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect(await signInRedirectTarget());
  }

  const ref = buildPersonalEntityRef(ctx.organizationId, ctx.userId);

  // Ensure the non-removable Overview exists before listing (the shell does not
  // ensure). Personal seeds it EMPTY — no entity-summary portlets (#702 is not
  // needed here). Idempotent: a pre-existing (migrated) row is found, not
  // double-created.
  const overview = await ensureEntityOverviewAction(ref);

  // SSR seed: the Overview-inclusive list + the selected Overview's config, so
  // the shell paints immediately. Both depend only on the ensured Overview id,
  // so fetch them together.
  const [list, config] = await Promise.all([
    listEntityDashboardsAction(ref),
    getEntityDashboardConfigAction(ref, overview.id),
  ]);

  const dataSource: EntityDashboardsDataSource = bindPersonalDashboardsDataSource(
    ref,
    {
      listEntityDashboardsAction,
      getEntityDashboardConfigAction,
      createEntityDashboardAction,
      renameEntityDashboardAction,
      deleteEntityDashboardAction,
      saveEntityDashboardConfigAction,
    },
  );

  // Concept B on the personal scope (cinatra#2474 PR4) — the issue's
  // "Personal = Create + B", which PR3 recorded as landing with this slice.
  //
  // `reference` is NULL and always will be: concept A's listing relation admits
  // only team/org/project (`dashboard_entity_links`), and spec §IX says a
  // personal scope is not an add-to-scope target and carries no Add. Passing
  // `null` is what preserves that — the toolbar keys the "Add dashboard" label,
  // the §IX.2 annotation and the open-add-picker action on the reference source
  // ALONE, so personal keeps its plain "+ New dashboard" exactly as before.
  // A catalog only changes what that button OPENS: the unified popup (Create +
  // catalog) when there is a catalog, the name prompt directly when there is
  // not, which is every instance that installs no dashboard-shipping extension.
  const actor = await getActorContext();
  const catalog = await buildScopeCatalogNode({
    actor,
    surface: {
      kind: "personal",
      orgId: ctx.organizationId,
      userId: ctx.userId,
    },
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Your scope"
        title="Personal"
        description="Your private dashboards, built from the cards you add."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Personal has no Settings pane (#1904), so its entity-page tablist is
            Dashboards alone (spec §IX). */}
        <EntityScopeTabs dashboardsHref="/personal" active="dashboards" />
        {/* The unified Add-dashboard popup's sources (cinatra#2474 PR3/PR4).
            Personal gets the catalog and NEVER the §IX.1 reference source. */}
        <ScopeAddSourcesProvider
          scopeLabel="Personal"
          reference={null}
          catalog={catalog}
        >
          <EntityDashboardsShell
            dataSource={dataSource}
            pageAnchor="personal"
            initialData={{ list, selectedId: overview.id, config }}
          />
        </ScopeAddSourcesProvider>
      </PageContent>
    </Main>
  );
}
