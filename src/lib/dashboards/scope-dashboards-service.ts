import "server-only";
/**
 * The scope Dashboards tab — SERVER service (cinatra#1897 B4; the ratified design
 * spec at design@bb9230d9b, `specs/app-artifacts.html` §IX). The I/O adapter that
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
import { sql, type SQL } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";

import type { ActorContext } from "@/lib/authz/actor-context";
import { actorMaySeeRow } from "@/lib/derived-store-ownership";
import { readObjectsByType } from "@/lib/objects-store";
import { requestArtifactPromotion } from "@/lib/artifacts/artifact-promotion-request";
import { betterAuthDb } from "@/lib/better-auth-db";
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

const ENTITY_LABEL_PREFIX: Record<string, string> = {
  team: "Team",
  organization: "Organization",
  project: "Project",
  user: "Personal",
  workspace: "Workspace",
};

/** The home descriptor a row resolves to (its canonical anchor). */
type HomeDescriptor = { kind: string; id: string | null };

function homeDescriptorOf(row: ScopeDashboardRow): HomeDescriptor {
  if (row.projectId) return { kind: "project", id: row.projectId };
  if (row.entityType && row.entityId)
    return { kind: row.entityType, id: row.entityId };
  return { kind: row.ownerLevel, id: row.ownerId };
}

/**
 * Build a Drizzle SQL fragment for a Postgres `ARRAY[...]` literal of text
 * values, one bind parameter per element.
 *
 * Drizzle's `sql` tag spreads a JS array `${arr}` as a tuple of positional
 * parameters (`($1, $2, ...)`), NOT as a single array bind. Inside `ANY(...)`
 * Postgres then parses that tuple as a row-expression and rejects it at runtime
 * (`malformed array literal` / `42809 op ANY/ALL (array) requires array on right
 * side`), and a trailing `::text[]` cast does NOT save you — a record cannot be
 * cast to an array. This helper emits `ARRAY[$1, $2, ..., $N]` — a real Postgres
 * array on the RHS, no injection surface. Callers MUST guard on a non-empty set
 * (`ARRAY[]` is ambiguous without an element type). Mirrors the converged idiom
 * in `packages/skills/src/skill-paths.ts` and `packages/agents/src/store.ts`.
 */
function buildTextArraySql(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]`;
}

/** The better-auth `public."team"` name query — the exact SQL sent to
 *  node-postgres, exported as a test seam (see
 *  scope-entity-labels-any-binding.test.ts). The ids MUST be non-empty
 *  (buildTextArraySql invariant). */
export function _teamNamesQuery(ids: readonly string[]): SQL {
  return sql`SELECT id, name FROM public."team" WHERE id = ANY(${buildTextArraySql(ids)})`;
}

/** The better-auth `public."organization"` name query — the exact SQL sent to
 *  node-postgres, exported as a test seam. The ids MUST be non-empty. */
export function _orgNamesQuery(ids: readonly string[]): SQL {
  return sql`SELECT id, name FROM public."organization" WHERE id = ANY(${buildTextArraySql(ids)})`;
}

/**
 * Batch-resolve entity-named labels ("Team: Growth", "Organization: Acme Corp")
 * for a set of (kind, id) homes. Team + organization names come from the
 * better-auth tables; a project degrades to the bare "Project" prefix when its
 * name is not resolved here (documented; the tenant fence still holds). A missing
 * name falls back to the tier prefix.
 *
 * Exported so the REAL node-postgres betterAuthDb path is covered by an
 * integration test (resolve-entity-labels.integration.test.ts) — the unit
 * conformance + app-db migration proofs do not exercise betterAuthDb.
 */
export async function resolveEntityLabels(
  homes: readonly HomeDescriptor[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const teamIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const h of homes) {
    if (!h.id) continue;
    if (h.kind === "team") teamIds.add(h.id);
    else if (h.kind === "organization") orgIds.add(h.id);
  }
  const nameByKey = new Map<string, string>();
  if (teamIds.size > 0) {
    const rows = await betterAuthDb.execute<{ id: string; name: string }>(
      _teamNamesQuery([...teamIds]),
    );
    for (const r of rows.rows ?? []) nameByKey.set(`team:${r.id}`, r.name);
  }
  if (orgIds.size > 0) {
    const rows = await betterAuthDb.execute<{ id: string; name: string }>(
      _orgNamesQuery([...orgIds]),
    );
    for (const r of rows.rows ?? [])
      nameByKey.set(`organization:${r.id}`, r.name);
  }
  for (const h of homes) {
    const prefix = ENTITY_LABEL_PREFIX[h.kind] ?? h.kind;
    const name = h.id ? nameByKey.get(`${h.kind}:${h.id}`) : undefined;
    out.set(labelKey(h), name ? `${prefix}: ${name}` : prefix);
  }
  return out;
}

function labelKey(h: HomeDescriptor): string {
  return `${h.kind}:${h.id ?? ""}`;
}

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

  // Resolve the entity-named home label for every LISTED row (its own home may be
  // a different entity). Home rows read "canonical home", no name needed.
  const labels = await resolveEntityLabels(listed.map(homeDescriptorOf));

  const rows: ScopeDashboardTabRow[] = [
    ...homed
      .map((r) => projectRow(r, canManage, "canonical home", updatedRel(r.updatedAt)))
      .sort(byName),
    ...listed
      .map((r) => {
        const label = labels.get(labelKey(homeDescriptorOf(r))) ?? "Dashboard";
        return projectRow(
          r,
          canManage,
          `home: ${label}`,
          updatedRel(r.updatedAt),
        );
      })
      .sort(byName),
  ];

  return { scopeLabel: input.scopeLabel, rows, canManage };
}

function projectRow(
  r: ScopeDashboardRow,
  canManage: boolean,
  homePart: string,
  rel: string,
): ScopeDashboardTabRow {
  return {
    dashboardId: r.dashboardId,
    name: r.name,
    metaLine: `${homePart} · updated ${rel}`,
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

  // Names + home descriptors from the dashboards rows for these ids.
  const ids = visibleRows.map((o) => o.id);
  const nameById = await dashboardNamesByIds(ids);
  const homeDescriptors = visibleRows.map((o) => ({
    id: o.id,
    home: homeOfObject(o),
  }));
  const labels = await resolveEntityLabels(homeDescriptors.map((h) => h.home));

  const candidates: ScopeAddCandidate[] = visibleRows.map((o) => {
    const home = homeOfObject(o);
    return {
      id: o.id,
      ownerLevel: o.ownerLevel,
      ownerId: o.ownerId,
      visibility: o.visibility,
      projectId: o.projectId,
      orgId: o.orgId,
      name: nameById.get(o.id) ?? "Untitled dashboard",
      homeLabel: labels.get(labelKey(home)) ?? null,
    };
  });

  const model = buildAddPickerModel({
    actor: input.actor,
    scope: input.scope,
    actorMayWriteScope: canWrite,
    candidates,
  });

  const scopeWord = SCOPE_WORD[input.scope.kind];
  return model.map((m) => {
    if (m.disposition.kind === "addable") {
      const visWord = visibilityWord(
        candidates.find((c) => c.id === m.dashboardId)?.visibility ?? null,
      );
      return {
        dashboardId: m.dashboardId,
        name: m.name,
        homeNote: `home: ${m.homeLabel ?? "Dashboard"} · ${visWord}-visible`,
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

function homeOfObject(o: {
  projectId: string | null;
  ownerLevel: string;
  ownerId: string | null;
}): HomeDescriptor {
  if (o.projectId) return { kind: "project", id: o.projectId };
  return { kind: o.ownerLevel, id: o.ownerId };
}

function visibilityWord(visibility: string | null): string {
  switch (visibility) {
    case "team":
      return "team";
    case "organization":
      return "org";
    case "public":
      return "public";
    default:
      return "scope";
  }
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
