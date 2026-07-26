import "server-only";
/**
 * The scope Dashboards tab — SERVER service (cinatra#1897 B4; the ratified design
 * spec at design@0ead5d0c5, `specs/app-artifacts.html` §IX). The I/O adapter that
 * composes the pure pieces:
 *
 *   - the junction store (`@cinatra-ai/dashboards/entity-links`) — Home +
 *     Listed reads, add/remove;
 *   - the objects substrate (`readObjectsByType`) — the canonical ownership
 *     tuples (owner_level/owner_id/visibility/project_id/org_id) for the actor's
 *     visible dashboards, the collection-add contract's row input;
 *   - the pure authorization (`actorMayWriteScope`, `authorizeScopeAdd`,
 *     `buildAddPickerModel`) — the three-gate contract (cinatra#1886);
 *   - the #1437 promotion store — the scope-invisible recourse.
 *
 * Every mutation RE-AUTHORIZES here (the render gate cannot protect a later
 * server-action invocation), fail-closed.
 */
import { formatDistanceToNow } from "date-fns";

import type { ActorContext } from "@/lib/authz/actor-context";
import { actorMaySeeRow } from "@/lib/derived-store-ownership";
import { readObjectsByType } from "@/lib/objects-store";
import { requestArtifactPromotion } from "@/lib/artifacts/artifact-promotion-request";
import { canonicalDashboardPath } from "@cinatra-ai/dashboards/canonical-path";
import {
  addDashboardEntityLink,
  dashboardNamesByIds,
  listScopeHomedDashboards,
  listScopeListedDashboards,
  listScopePresentDashboardIds,
  removeDashboardEntityLink,
  type ListingScope,
  type ScopeDashboardRow,
} from "@cinatra-ai/dashboards/entity-links";
import type { ListingScopeKind } from "@cinatra-ai/dashboards/entity-links";
import { DASHBOARD_ARTIFACT_OBJECT_TYPE } from "@/lib/dashboards/dashboard-artifact-surface";
import { actorMayWriteScope } from "@/lib/dashboards/scope-write-authority";
import {
  authorizeScopeAdd,
  buildAddPickerModel,
  type ScopeAddCandidate,
} from "@/lib/dashboards/scope-dashboards-collection";
import type {
  AddPickerCandidateView,
  ScopeDashboardsTabData,
  ScopeDashboardTabRow,
  ScopeListingMutation,
} from "@/components/dashboards/scope-dashboards-contract";

const SCOPE_WORD: Record<ListingScopeKind, string> = {
  team: "team",
  organization: "organization",
  project: "project",
};

function updatedRel(updatedAt: Date | string | null): string {
  if (!updatedAt) return "recently";
  const d = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  return Number.isNaN(d.getTime())
    ? "recently"
    : formatDistanceToNow(d, { addSuffix: true });
}

/**
 * Build the tab's data: the Home rows (canonically homed here) followed by the
 * Listed rows (secondary listings), each projected to the client row model. Home
 * first, then by name (case-insensitive) — matching the §IX example order.
 *
 * Whether a row is homed here or merely listed here is NOT surfaced (spec §IX —
 * no Home / Listed badge, no `home:` provenance): every row reads the same and
 * differs only in the Remove control, which a listing carries and a homed row
 * does not (`canRemove`).
 */
export async function getScopeDashboardsTabData(input: {
  actor: ActorContext;
  scope: ListingScope;
  scopeLabel: string;
}): Promise<ScopeDashboardsTabData> {
  const canManage = actorMayWriteScope(input.actor, input.scope);
  const [homed, listed] = await Promise.all([
    listScopeHomedDashboards(input.scope),
    listScopeListedDashboards(input.scope),
  ]);

  const rows: ScopeDashboardTabRow[] = [
    ...homed.map((r) => projectRow(r, canManage)).sort(byName),
    ...listed.map((r) => projectRow(r, canManage)).sort(byName),
  ];

  return { scopeLabel: input.scopeLabel, rows, canManage };
}

function projectRow(
  r: ScopeDashboardRow,
  canManage: boolean,
): ScopeDashboardTabRow {
  return {
    dashboardId: r.dashboardId,
    name: r.name,
    metaLine: `updated ${updatedRel(r.updatedAt)}`,
    relation: r.relation,
    canonicalHref: canonicalDashboardPath({
      id: r.dashboardId,
      entityType: r.entityType,
      entityId: r.entityId,
    }),
    // Only a LISTED row is removable, and only by a manager (§IX.2).
    canRemove: r.relation === "listed" && canManage,
  };
}

function byName(a: ScopeDashboardTabRow, b: ScopeDashboardTabRow): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
}

/**
 * The add-picker candidate pool: the dashboards the ACTOR can see (the objects
 * read filter, in-memory `actorMaySeeRow`), excluding any already homed or listed
 * here, each dispositioned by the collection-add contract. Only shown to a
 * manager — this returns `null` to a non-manager (fail-closed; the client never
 * renders the picker for a non-manager anyway).
 */
export async function listScopeAddCandidates(input: {
  actor: ActorContext;
  scope: ListingScope;
}): Promise<AddPickerCandidateView[] | null> {
  const canWrite = actorMayWriteScope(input.actor, input.scope);
  if (!canWrite) return null;

  // The org's dashboard objects (canonical ownership tuples), filtered to those
  // the actor may actually see, then to those not already present in the scope.
  const objects = readObjectsByType(DASHBOARD_ARTIFACT_OBJECT_TYPE, {
    orgId: input.actor.organizationId,
  });
  const present = await listScopePresentDashboardIds(input.scope);
  const visibleRows = objects.filter(
    (o) =>
      !present.has(o.id) &&
      actorMaySeeRow(input.actor, {
        ownerLevel: o.ownerLevel,
        ownerId: o.ownerId,
        visibility: o.visibility,
        projectId: o.projectId,
        orgId: o.orgId,
      }),
  );
  if (visibleRows.length === 0) return [];

  // Names from the dashboards rows for these ids.
  const ids = visibleRows.map((o) => o.id);
  const nameById = await dashboardNamesByIds(ids);

  const candidates: ScopeAddCandidate[] = visibleRows.map((o) => ({
    id: o.id,
    ownerLevel: o.ownerLevel,
    ownerId: o.ownerId,
    visibility: o.visibility,
    projectId: o.projectId,
    orgId: o.orgId,
    name: nameById.get(o.id) ?? "Untitled dashboard",
    // The candidate's own home is no longer surfaced (spec §IX.1 dropped the
    // `home: <entity>` provenance) — the picker states visibility eligibility only.
    homeLabel: null,
  }));

  const model = buildAddPickerModel({
    actor: input.actor,
    scope: input.scope,
    actorMayWriteScope: canWrite,
    candidates,
  });

  // The candidate note states visibility eligibility only (spec §IX.1): an
  // addable candidate the scope can already see, a scope-invisible candidate's
  // promotion recourse, or a plain not-addable — never `home: <entity>`.
  const scopeWord = SCOPE_WORD[input.scope.kind];
  return model.map((m) => {
    if (m.disposition.kind === "addable") {
      return {
        dashboardId: m.dashboardId,
        name: m.name,
        homeNote: `the ${scopeWord} can already see this`,
        disposition: "addable" as const,
      };
    }
    if (m.disposition.kind === "promotion") {
      const targetWord =
        m.disposition.toVisibility === "team" ? "team" : "organization";
      return {
        dashboardId: m.dashboardId,
        name: m.name,
        homeNote: `private — the ${scopeWord} can’t see it yet`,
        disposition: "promotion" as const,
        promotionLabel: `Request ${targetWord} visibility…`,
      };
    }
    return {
      dashboardId: m.dashboardId,
      name: m.name,
      homeNote: `not visible to this ${scopeWord}`,
      disposition: "not-addable" as const,
    };
  });
}

/**
 * Add a secondary listing. RE-AUTHORIZES the full three-gate contract on the
 * live actor: the dashboard's canonical ownership tuple is re-read from the
 * objects substrate, the scope-write gate re-evaluated, the scope-vantage guard
 * re-checked. A scope-invisible dashboard is REFUSED (never widened silently) —
 * the recourse is `requestScopePromotion`.
 */
export async function addScopeListing(input: {
  actor: ActorContext;
  scope: ListingScope;
  dashboardId: string;
}): Promise<ScopeListingMutation> {
  const canWrite = actorMayWriteScope(input.actor, input.scope);
  const row = objectTupleFor(input.dashboardId, input.actor.organizationId);
  if (!row) return { ok: false, reason: "not-found" };

  const decision = authorizeScopeAdd({
    actor: input.actor,
    scope: input.scope,
    actorMayWriteScope: canWrite,
    row: { id: input.dashboardId, ...row },
  });
  if (!decision.ok) {
    if (decision.reason === "scope_cannot_see_row")
      return { ok: false, reason: "not-visible-to-scope" };
    return { ok: false, reason: "denied" };
  }

  await addDashboardEntityLink({
    dashboardId: input.dashboardId,
    entityType: input.scope.kind,
    entityId: input.scope.scopeId,
    organizationId: input.scope.orgId,
    createdBy: input.actor.principalId,
  });
  return { ok: true };
}

/**
 * Remove a secondary listing. Gated on the scope-write authority only (removing a
 * listing is a scope-write, not a row read). Fail-closed for a non-manager.
 */
export async function removeScopeListing(input: {
  actor: ActorContext;
  scope: ListingScope;
  dashboardId: string;
}): Promise<ScopeListingMutation> {
  if (!actorMayWriteScope(input.actor, input.scope))
    return { ok: false, reason: "denied" };
  await removeDashboardEntityLink({
    dashboardId: input.dashboardId,
    entityType: input.scope.kind,
    entityId: input.scope.scopeId,
    organizationId: input.scope.orgId,
  });
  return { ok: true };
}

/**
 * The scope-invisible recourse (§IX.1): offer the #1437 promotion request that
 * would make the scope able to see the dashboard. The offer is re-derived from
 * the contract (tenant + widen + scope-satisfying target + actor team
 * membership), so a request that the #1437 flow would bounce is never submitted.
 */
export async function requestScopePromotion(input: {
  actor: ActorContext;
  scope: ListingScope;
  dashboardId: string;
}): Promise<ScopeListingMutation> {
  const canWrite = actorMayWriteScope(input.actor, input.scope);
  const row = objectTupleFor(input.dashboardId, input.actor.organizationId);
  if (!row) return { ok: false, reason: "not-found" };

  const decision = authorizeScopeAdd({
    actor: input.actor,
    scope: input.scope,
    actorMayWriteScope: canWrite,
    row: { id: input.dashboardId, ...row },
  });
  // A promotion is offered ONLY on a scope-see failure carrying a non-null offer.
  if (decision.ok) return { ok: false, reason: "invalid" }; // already visible — no recourse needed
  if (decision.reason !== "scope_cannot_see_row" || !decision.promotion)
    return { ok: false, reason: "denied" };

  const result = await requestArtifactPromotion({
    orgId: input.scope.orgId,
    artifactId: decision.promotion.artifactId,
    requestedBy: input.actor.principalId,
    toVisibility: decision.promotion.toVisibility,
    ...(decision.promotion.targetTeamId
      ? { targetTeamId: decision.promotion.targetTeamId }
      : {}),
    actor: input.actor,
  });
  if (!result.ok) return { ok: false, reason: "invalid" };
  return { ok: true };
}

/** The canonical ownership tuple for a dashboard's objects twin, tenant-fenced. */
function objectTupleFor(
  dashboardId: string,
  orgId: string | undefined,
): {
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null;
  orgId: string | null;
} | null {
  const objects = readObjectsByType(DASHBOARD_ARTIFACT_OBJECT_TYPE, {
    ...(orgId ? { orgId } : {}),
  });
  const match = objects.find((o) => o.id === dashboardId);
  if (!match) return null;
  return {
    ownerLevel: match.ownerLevel,
    ownerId: match.ownerId,
    visibility: match.visibility,
    projectId: match.projectId,
    orgId: match.orgId,
  };
}
