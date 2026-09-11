import "server-only";
/**
 * Server-component wiring for the scope Dashboards collection panel
 * (cinatra#1897 B4; the ratified design spec at design@0ead5d0c5,
 * `specs/app-artifacts.html` §IX). One mount point the three entity landings
 * share: it reads the panel data server-side (Home + Listed rows, the write
 * gate) and binds the one server action the panel drives. The actor never
 * crosses to the client — only the already-authorized view models + the bound
 * action thunk.
 *
 * cinatra#2474 PR3 narrowed what crosses: the panel is handed `removeListing`
 * ALONE. The §IX.1 add actions (`listCandidates` / `addListing` /
 * `requestPromotion`) now ride the landing's `ScopeAddSourcesProvider` straight
 * to the unified Add-dashboard popup, and the landing hands those over only to a
 * principal who may write the scope — so a read-only member's browser never
 * receives a handle to an action they may not take. The server re-authorizes
 * either way; this is capability minimization on top of it.
 */
import { getScopeDashboardsTabData } from "@/lib/dashboards/scope-dashboards-service";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";
import { ScopeDashboardsTab, ScopeDashboardsTabError } from "./scope-dashboards-tab";
import { ScopeAddDashboardButton } from "./scope-add-dashboard-button";
import type {
  ScopeListingRemovalSource,
  ScopeDashboardsTabData,
} from "./scope-dashboards-contract";
import {
  scopeRemoveListingAction,
  type ScopeActionArg,
} from "@/components/dashboards/scope-dashboards-actions";

export async function ScopeDashboardsSection({
  actor,
  scope,
  entityLabel,
  allowRemoval = true,
}: {
  actor: ActorContext;
  scope: ListingScope;
  /** The entity the drawn caption names — "Team: Growth", "Organization:
   *  Northwind Analytics", "Project: Q3 Outbound". The hosting page owns the
   *  name (it resolved it behind its own read gate); the tab never reads one. */
  entityLabel: string;
  /**
   * May this MOUNT offer Remove at all? (cinatra#2807 fix leg 5, convergence
   * round.) Default `true` — the landings that only ever render inside the
   * actor's own tenant keep the shipped behaviour untouched.
   *
   * A landing that renders for a viewer OUTSIDE the ambient tenant passes
   * `false`. `actorMayWriteScope` is NOT sufficient on its own there: its very
   * first arm is `if (actor.platformRole === "platform_admin") return true`, so
   * a platform admin's `canRemove` is true across tenants by the deliberate
   * scope-ratchet convention. That convention is fine where the surface was
   * already reachable, but a mount that newly renders outside the active tenant
   * must not ALSO newly offer a cross-tenant Remove it never offered before.
   * Withholding the source is suppression, not a disabled control (§IX.2).
   */
  allowRemoval?: boolean;
}) {
  // Contain a service failure in the DESIGNED error frame (§IX/§X data-state
  // "error") instead of bubbling an unhandled Next 500 up through the route: the
  // panel's own read (Home/Listed rows, the entity-name labels) can fail on a
  // transient store error, and the surface must degrade to "Couldn't load this
  // scope's dashboards", not a blank 500.
  let data: ScopeDashboardsTabData;
  try {
    data = await getScopeDashboardsTabData({ actor, scope });
  } catch (err) {
    console.error(
      `[scope-dashboards] failed to load ${scope.kind} scope ${scope.scopeId}:`,
      err,
    );
    return <ScopeDashboardsTabError />;
  }
  const scopeArg: ScopeActionArg = {
    kind: scope.kind,
    scopeId: scope.scopeId,
    orgId: scope.orgId,
  };
  // Bind the server-derived scope to the action (Next server-action .bind), so
  // the client drives it with no scope argument — it can neither read nor forge
  // the scope.
  // Capability minimization: where the mount withholds removal the client is
  // handed NO removal handle at all, so no Remove renders on any row. The
  // server action re-authorizes independently either way.
  const removal: ScopeListingRemovalSource | undefined = allowRemoval
    ? { removeListing: scopeRemoveListingAction.bind(null, scopeArg) }
    : undefined;
  return (
    <ScopeDashboardsTab
      data={data}
      removal={removal}
      caption={{ kind: "entity", entityLabel }}
      // The drawn Add sits in the caption row. The button suppresses itself
      // where the landing handed down no reference source, which it does only
      // for a principal who may write the collection (§IX.2).
      add={<ScopeAddDashboardButton />}
    />
  );
}
