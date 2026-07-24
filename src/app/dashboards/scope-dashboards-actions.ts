"use server";
/**
 * Server actions for the scope Dashboards tab (cinatra#1897 B4; the ratified
 * design spec at design@bb9230d9b, `specs/app-artifacts.html` §IX). Each is
 * bound (server-side) to the scope the hosting entity page derived, so the scope
 * crosses the client boundary already server-authored — the client never
 * supplies (or forges) the scope's owner axis. Every action RE-RESOLVES the live
 * actor and RE-AUTHORIZES: the render gate cannot protect a later invocation
 * after an org switch. Fail-closed (a missing session / cross-tenant scope is a
 * denial, never a widen).
 */
import { getActorContext } from "@/lib/auth-session";
import type {
  ListingScope,
  ListingScopeKind,
} from "@cinatra-ai/dashboards/entity-links";
import {
  addScopeListing,
  listScopeAddCandidates,
  removeScopeListing,
  requestScopePromotion,
} from "@/lib/dashboards/scope-dashboards-service";
import type {
  AddPickerCandidateView,
  ScopeListingMutation,
} from "@/components/dashboards/scope-dashboards-contract";

/** The server-derived scope a bound action carries (safe: the page authors it). */
export type ScopeActionArg = {
  readonly kind: ListingScopeKind;
  readonly scopeId: string;
  readonly orgId: string;
};

/**
 * Re-resolve the live actor and TENANT-FENCE it to the scope's org. Only the
 * scope's own tenant (or a platform admin) may proceed — a scope in another
 * tenant is refused before any service call. Returns the actor + a normalized
 * `ListingScope`, or null (fail-closed).
 */
async function authorizeScopeAction(
  scope: ScopeActionArg,
): Promise<{ actor: NonNullable<Awaited<ReturnType<typeof getActorContext>>>; listingScope: ListingScope } | null> {
  const actor = await getActorContext();
  if (!actor) return null;
  if (
    actor.organizationId !== scope.orgId &&
    actor.platformRole !== "platform_admin"
  ) {
    return null;
  }
  return {
    actor,
    listingScope: { kind: scope.kind, scopeId: scope.scopeId, orgId: scope.orgId },
  };
}

export async function scopeListCandidatesAction(
  scope: ScopeActionArg,
): Promise<AddPickerCandidateView[] | null> {
  const ctx = await authorizeScopeAction(scope);
  if (!ctx) return null;
  return listScopeAddCandidates({ actor: ctx.actor, scope: ctx.listingScope });
}

export async function scopeAddListingAction(
  scope: ScopeActionArg,
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const ctx = await authorizeScopeAction(scope);
  if (!ctx) return { ok: false, reason: "denied" };
  return addScopeListing({
    actor: ctx.actor,
    scope: ctx.listingScope,
    dashboardId,
  });
}

export async function scopeRemoveListingAction(
  scope: ScopeActionArg,
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const ctx = await authorizeScopeAction(scope);
  if (!ctx) return { ok: false, reason: "denied" };
  return removeScopeListing({
    actor: ctx.actor,
    scope: ctx.listingScope,
    dashboardId,
  });
}

export async function scopeRequestPromotionAction(
  scope: ScopeActionArg,
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const ctx = await authorizeScopeAction(scope);
  if (!ctx) return { ok: false, reason: "denied" };
  return requestScopePromotion({
    actor: ctx.actor,
    scope: ctx.listingScope,
    dashboardId,
  });
}
