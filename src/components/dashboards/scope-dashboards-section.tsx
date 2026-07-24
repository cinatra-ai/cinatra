import "server-only";
/**
 * Server-component wiring for the scope Dashboards tab (cinatra#1897 B4; the
 * ratified design spec at design@bb9230d9b, `specs/app-artifacts.html` §IX).
 * One mount point the three entity `/dashboards` routes share: it reads the
 * tab data server-side (Home + Listed rows, the write gate), binds the
 * scope-bound server actions, and hands both to the client tab. The actor never
 * crosses to the client — only the already-authorized view models + the bound
 * action thunks.
 */
import { getScopeDashboardsTabData } from "@/lib/dashboards/scope-dashboards-service";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";
import { ScopeDashboardsTab } from "./scope-dashboards-tab";
import type { ScopeDashboardsDataSource } from "./scope-dashboards-contract";
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
  const data = await getScopeDashboardsTabData({ actor, scope, scopeLabel });
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
