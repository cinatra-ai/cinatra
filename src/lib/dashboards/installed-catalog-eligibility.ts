/**
 * The PURE eligibility core for concept B's installed-catalog read
 * (cinatra#2474 PR4). No I/O — the server read (`installed-catalog-read.ts`)
 * fetches, this decides, so every rule below is directly unit-testable.
 *
 * Three independent rules live here. Each is a NARROWING; none can widen what
 * the store or the extension access evaluator already decided.
 */
import type { DashboardEntityRef } from "@cinatra-ai/dashboards/entity-identity";
import { normalizeCreatableDashboardName } from "@cinatra-ai/dashboards/entity-identity";
import type { AccessScopeVantage } from "@cinatra-ai/extensions/access-scope-vantage";

import type { ActorContext } from "@/lib/authz/actor-context";
import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";

import type { CatalogSurface } from "./installed-catalog-contract";

/**
 * SCOPE REACH — may `actor` be on this surface at all, RIGHT NOW?
 *
 * ── WHY THIS EXISTS (cinatra#2474 PR5, codex convergence r0/HIGH-1) ────────
 * PR4's read is taken during a landing's server render, so the landing's own
 * membership gate had already admitted the actor and this question never needed
 * asking. PR5's action is client-reachable and LIVES LONGER THAN THAT RENDER: a
 * bound action reference held by the SAME user still resolves after they are
 * removed from the team, after a project grant is revoked, or after the entity
 * itself is deleted. The tenant fence does not catch it (same org), and neither
 * does the destination fence (the row is genuinely theirs) — nor can the writer,
 * which sees a user-owned row and correctly allows it. So the reach the render
 * gate proved must be re-proved at write time, and this is that predicate.
 *
 * ── EVERY ARM IS A LIVE-RESOLVED MEMBERSHIP AXIS ──────────────────────────
 * Deliberately so, because that makes the predicate prove TWO things at once —
 * that the actor still belongs, and that the entity still EXISTS — with no I/O
 * of its own. Each axis on an `ActorContext` was resolved this request from a
 * live join, so a deleted team or project simply is not in it (codex convergence
 * r1: a pure role check would have let an org admin write onto a deleted team).
 *
 *   tenant        — the actor's active org IS the surface's, AND they hold a
 *                   resolved membership role in it (`resolveOrgRoleForSession`
 *                   reads the membership table; a removed member resolves to
 *                   `undefined`). This costs nothing in permissiveness: the
 *                   org-write kernel already refuses every dashboard write from
 *                   an actor with no membership-minted authority, so a principal
 *                   this arm turns away could not have written anyway — it is
 *                   turned away BEFORE the store reads rather than after.
 *   personal      — the actor IS the scope; the destination fence already proved
 *                   the collection is theirs.
 *   organization  — the org landing admits any member of the tenant, which the
 *                   tenant arm above states exactly; the surface's own org-scope
 *                   invariant (`scopeId === orgId`) is the rest of it.
 *   team          — MEMBERSHIP, via `teamIds` (the active-org projection of
 *                   `readTeamsForUser`).
 *   project       — the sealed-room read gate, unchanged and not restated:
 *                   `actorHoldsProjectGrant` over `readProjectGrantsForUser`'s
 *                   resolved grants, the canonical predicate every project read
 *                   surface uses.
 *
 * ── ONE DELIBERATE NARROWING vs PR4's LIST, STATED ────────────────────────
 * The team landing additionally admits a MANAGER who may view without a
 * membership row (org owner/admin, platform admin), and PR4's read showed them
 * the catalog. This predicate does not, so they now see no catalog section on a
 * team they do not belong to. That is chosen, not overlooked: membership is what
 * makes the team's existence provable here without a query, and the affordance it
 * withholds is small and strange — a private dashboard of the manager's own, on
 * the page of a team they are not in. A manager who joins the team gets it back.
 *
 * PURE and FAIL-CLOSED: reads only resolved `ActorContext` axes, and anything
 * unmatched is a denial. It can only ever NARROW what the other gates admit.
 */
export function actorMayReachSurface(
  actor: ActorContext,
  surface: CatalogSurface,
): boolean {
  if (!surface.orgId || actor.organizationId !== surface.orgId) return false;
  // Membership in the tenant, not merely a session pointing at it.
  if (!actor.orgRole) return false;

  switch (surface.kind) {
    case "personal":
      return true;
    case "organization":
      // The scope IS the tenant; `destinationRefForSurface` pins that invariant.
      return surface.scopeId === surface.orgId;
    case "team":
      return !!surface.scopeId && (actor.teamIds ?? []).includes(surface.scopeId);
    case "project":
      return !!surface.scopeId && actorHoldsProjectGrant(actor, surface.scopeId);
    default: {
      const _exhaustive: never = surface;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * The surface's ACCESS VANTAGE — the scope whose generic member the extension
 * access policy is evaluated against (`policyFieldAdmitsScopeVantage`).
 */
export function vantageForSurface(surface: CatalogSurface): AccessScopeVantage {
  return surface.kind === "personal"
    ? { kind: "personal", orgId: surface.orgId }
    : { kind: surface.kind, orgId: surface.orgId, scopeId: surface.scopeId };
}

/**
 * The surface's DESTINATION — the `(entity, owner)` collection a PR5 copy would
 * land in. FULLY DERIVED from the surface descriptor plus the ACTOR'S OWN user
 * id; there is no independent ref input to disagree with, so the scope a
 * template is authorized against and the collection it would be written to are
 * structurally the same thing (codex convergence r1: an independently-supplied
 * ref made the "acting user" invariant only as strong as whatever the caller
 * put in the descriptor).
 *
 * `ownerLevel` is always `"user"` and `ownerId` always the acting user, matching
 * what every entity landing binds:
 *   personal     → {entityType:"personal",     entityId: orgId,      ownerLevel:"user", ownerId:userId}
 *   team         → {entityType:"team",         entityId: team.id,    ownerLevel:"user", ownerId:userId}
 *   project      → {entityType:"project",      entityId: project.id, ownerLevel:"user", ownerId:userId}
 *   organization → {entityType:"organization", entityId: org.id,     ownerLevel:"user", ownerId:userId}
 *
 * The organization arm reproduces `buildOrganizationDetailRef` exactly — the
 * PER-INSTANCE `"organization"` type, never the migratable `"organizations"`
 * index surface. A test pins the two together against that builder, so the
 * spelling cannot drift.
 *
 * Fails closed (`null`) on any structurally invalid surface, and — for the
 * organization arm — on the scope invariant `scopeId === orgId` the org landing
 * always satisfies.
 */
export function destinationRefForSurface(
  surface: CatalogSurface,
  actorUserId: string,
): DashboardEntityRef | null {
  if (!actorUserId || !surface.orgId) return null;
  // The descriptor's user must BE the acting user. Every arm below, and the
  // permissive personal vantage that depends on them, is sound only under this.
  if (surface.userId !== actorUserId) return null;

  switch (surface.kind) {
    case "personal":
      return {
        entityType: "personal",
        entityId: surface.orgId,
        ownerLevel: "user",
        ownerId: actorUserId,
      };
    case "team":
      if (!surface.scopeId) return null;
      return {
        entityType: "team",
        entityId: surface.scopeId,
        ownerLevel: "user",
        ownerId: actorUserId,
      };
    case "project":
      if (!surface.scopeId) return null;
      return {
        entityType: "project",
        entityId: surface.scopeId,
        ownerLevel: "user",
        ownerId: actorUserId,
      };
    case "organization":
      // The org-scope invariant (the scope IS the tenant), the same pin
      // `actorMayWriteScope`'s organization arm applies.
      if (!surface.scopeId || surface.scopeId !== surface.orgId) return null;
      return {
        entityType: "organization",
        entityId: surface.scopeId,
        ownerLevel: "user",
        ownerId: actorUserId,
      };
    default: {
      const _exhaustive: never = surface;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * FAIL-CLOSED destination invariant: the collection a copy would land in must
 * be the ACTING USER'S OWN. Every arm of the eligibility model leans on this —
 * most sharply the personal vantage, which admits every token precisely because
 * the only reader of the result is the actor the caller already authorized. If
 * this ever stops holding, the vantage arm stops being sound, so it is asserted
 * rather than assumed.
 */
export function destinationIsActorOwned(
  ref: DashboardEntityRef,
  userId: string,
): boolean {
  return (
    ref.ownerLevel === "user" && !!userId && ref.ownerId === userId
  );
}

/**
 * TEMPLATE-SCOPE COMPATIBILITY — may a template declaring `templateScope` be
 * offered on `surface`?
 *
 * `templateScope` is the dashboard config's own `scopeLevel`
 * (`user|team|organization|workspace|project`), stamped onto the template row by
 * `materializeExtensionTemplate`.
 *
 *   - `"project"` → offered NOWHERE. A project-scope template is not an
 *     offerable dashboard: `materializeExtensionInstanceForProject` is its
 *     operational form, the platform's own reader contract says the template row
 *     "must never render directly" (`isProjectTemplate`), and offering a copy
 *     would duplicate the extension's own per-project instance mechanism with a
 *     row the extension does not know about. A narrowing, stated as its own rule
 *     rather than borrowed from `excludeProjectTemplates`, whose contract is
 *     about direct RENDERING and does not reach this decision (codex
 *     convergence r0/Q6).
 *   - every other level → offered on every surface. The copy is written into the
 *     acting user's own `ownerLevel:"user"` collection whatever the surface, and
 *     the writer re-normalizes the config for that owner level
 *     (`normalizeConfigForWrite`'s `fallbackScopeOwnerLevel`), so the declared
 *     level does not restrict where the copy may live. PR5 owns whether the
 *     copied config is MEANINGFUL there; PR4 does not pretend to know.
 */
const OFFERABLE_TEMPLATE_SCOPES: ReadonlySet<string> = new Set([
  "user",
  "team",
  "organization",
  "workspace",
]);

export function templateScopeAdmitsSurface(
  templateScope: string | null,
  surface: CatalogSurface,
): boolean {
  void surface; // uniform across surfaces today — see the rule above
  // An ALLOWLIST, not `!== "project"` (codex convergence r1): a null, unknown or
  // mis-cased value is not evidence that the template is offerable, and reading
  // it as one would fail OPEN on exactly the corrupted metadata this rule exists
  // to catch. `materializeExtensionTemplate` always stamps the config's own
  // zod-validated `scopeLevel`, so anything outside this set is legacy or
  // damaged — and denied.
  return templateScope !== null && OFFERABLE_TEMPLATE_SCOPES.has(templateScope);
}

/**
 * The NAME-COLLISION filter.
 *
 * NOT an "already instantiated" check, and deliberately not described as one: a
 * PR5 copy is an ordinary dashboard carrying NO extension provenance
 * (`createEntityDashboard` writes `contributionId: null` and no `extensionId`),
 * so nothing in the destination identifies a row as having come from a template.
 * What this DOES answer is exact and useful: "is this template currently addable
 * without a name collision?" — `dashboards_entity_name_uniq` is over
 * `(org, entity_type, entity_id, owner_level, owner_id, name)`, so a template
 * whose name is already taken there is one whose add MUST FAIL.
 *
 * Consequences, stated rather than hidden: a user who renames their copy sees
 * the row return (and adding again then really does succeed), and an unrelated
 * dashboard that happens to share the name also withholds it. A read and a later
 * write are not atomic either, so PR5 must still surface a normal name-conflict
 * result.
 *
 * The prospective name is computed with the WRITER'S OWN rule
 * (`normalizeCreatableDashboardName`), so trim and reserved-name handling cannot
 * drift; a template whose name is not creatable at all (blank, or the reserved
 * "Overview") is dropped rather than offered as an add that could never land.
 * Comparison is case-SENSITIVE, matching the unique index over the raw column.
 */
export function isAddableWithoutNameCollision(
  templateName: string,
  existingNames: ReadonlySet<string>,
): boolean {
  const prospective = normalizeCreatableDashboardName(templateName);
  if (prospective === null) return false;
  return !existingNames.has(prospective);
}

/** The name a PR5 copy would actually persist, or `null` when uncreatable. */
export function prospectiveCopyName(templateName: string): string | null {
  return normalizeCreatableDashboardName(templateName);
}

/**
 * Deterministic catalog ordering: name, then package, then id — so two
 * templates sharing a display name still order stably across requests.
 */
export function compareCatalogRows(
  a: { readonly name: string; readonly packageName: string; readonly templateId: string },
  b: { readonly name: string; readonly packageName: string; readonly templateId: string },
): number {
  return (
    a.name.localeCompare(b.name) ||
    a.packageName.localeCompare(b.packageName) ||
    a.templateId.localeCompare(b.templateId)
  );
}
