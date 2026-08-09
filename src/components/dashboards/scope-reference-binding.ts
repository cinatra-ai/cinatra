import "server-only";
/**
 * The §IX.1 add-to-scope binding an entity landing hands to the unified
 * Add-dashboard popup (cinatra#2474 PR3).
 *
 * ONE place decides who gets it: `actorMayWriteScope` — the same pure predicate
 * the collection's mutations re-apply server-side (gate 2 of the collection-add
 * contract, §IX.2). A principal who may not write the scope gets `null`, so the
 * popup renders no reference section AND the toolbar renders no scope-level
 * "Add dashboard" at all: §IX.2's "suppression, not a disabled control",
 * enforced before anything reaches the browser.
 *
 * The returned thunks are Next server actions already `.bind`-ed to the
 * landing's SERVER-DERIVED scope, so the client can neither read nor forge the
 * scope's owner axis, and each action re-resolves the live actor and re-applies
 * its tenant fence on invocation (the render gate cannot protect a later call).
 */
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";
import { actorMayWriteScope } from "@/lib/dashboards/scope-write-authority";
import {
  scopeAddListingAction,
  scopeListCandidatesAction,
  scopeRequestPromotionAction,
  type ScopeActionArg,
} from "@/app/dashboards/scope-dashboards-actions";

import type { ScopeReferenceSource } from "./scope-dashboards-contract";

/**
 * The bound §IX.1 actions for `scope`, or `null` when `actor` may not write it.
 */
export function buildScopeReferenceSource(
  actor: ActorContext,
  scope: ListingScope,
): ScopeReferenceSource | null {
  if (!actorMayWriteScope(actor, scope)) return null;
  const scopeArg: ScopeActionArg = {
    kind: scope.kind,
    scopeId: scope.scopeId,
    orgId: scope.orgId,
  };
  return {
    listCandidates: scopeListCandidatesAction.bind(null, scopeArg),
    addListing: scopeAddListingAction.bind(null, scopeArg),
    requestPromotion: scopeRequestPromotionAction.bind(null, scopeArg),
  };
}
