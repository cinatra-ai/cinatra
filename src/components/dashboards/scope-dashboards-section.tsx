import "server-only";
/**
 * Server-component wiring for the scope Dashboards tab (cinatra#1897 B4; the
 * ratified design spec at design@0ead5d0c5, `specs/app-artifacts.html` §IX).
 * One mount point the three entity `/dashboards` routes share: it reads the
 * tab data server-side (Home + Listed rows, the write gate), binds the
 * scope-bound server actions, and hands both to the client tab. The actor never
 * crosses to the client — only the already-authorized view models + the bound
 * action thunks.
 */
import { getScopeDashboardsTabData } from "@/lib/dashboards/scope-dashboards-service";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";
import { ScopeDashboardsTab, ScopeDashboardsTabError } from "./scope-dashboards-tab";
import type {
  ScopeDashboardsDataSource,
  ScopeDashboardsTabData,
} from "./scope-dashboards-contract";
import {
  scopeAddListingAction,
  scopeListCandidatesAction,
  scopeRemoveListingAction,
  scopeRequestPromotionAction,
  type ScopeActionArg,
} from "@/app/dashboards/scope-dashboards-actions";

export async function ScopeDashboardsSection({
  actor,
  scope,
  scopeLabel,
}: {
  actor: ActorContext;
  scope: ListingScope;
  scopeLabel: string;
}) {
  // Contain a service failure in the DESIGNED error frame (§IX/§X data-state
  // "error") instead of bubbling an unhandled Next 500 up through the route: the
  // tab's own read (Home/Listed rows, the entity-name labels) can fail on a
  // transient store error, and the surface must degrade to "Couldn't load this
  // scope's dashboards", not a blank 500.
  let data: ScopeDashboardsTabData;
  try {
    data = await getScopeDashboardsTabData({ actor, scope, scopeLabel });
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
  // Bind the server-derived scope to each action (Next server-action .bind), so
  // the client drives them with no scope argument — it can neither read nor
  // forge the scope.
  const dataSource: ScopeDashboardsDataSource = {
    listCandidates: scopeListCandidatesAction.bind(null, scopeArg),
    addListing: scopeAddListingAction.bind(null, scopeArg),
    removeListing: scopeRemoveListingAction.bind(null, scopeArg),
    requestPromotion: scopeRequestPromotionAction.bind(null, scopeArg),
  };
  return <ScopeDashboardsTab data={data} dataSource={dataSource} />;
}
