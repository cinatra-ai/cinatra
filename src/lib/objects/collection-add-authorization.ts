/**
 * Collection-add authorization CONTRACT (cinatra#1886 C2 / epic #1883 D11).
 *
 * The reusable substrate seam every "add an existing row to a scope's
 * collection" surface calls. Adding a row `R` to a `scope`'s collection is
 * authorized iff ALL THREE hold:
 *
 *   1. actor-may-see(R)          — the acting principal can already open the
 *                                  row (the SAME visibility the read filter
 *                                  compiles: `actorMaySeeRow`).
 *   2. actor-may-write-scope     — the acting principal may write the scope's
 *                                  collection surface. This is the CONSUMER's
 *                                  authorization (the junction/collection
 *                                  permission model — B4/#1897 owns it), so the
 *                                  contract takes it as an injected decision
 *                                  rather than guessing a scope-write model C2
 *                                  cannot yet know.
 *   3. scopeMaySeeRow(scope, R)  — a GENERIC member of the scope could already
 *                                  open the row (the scope-vantage guard). This
 *                                  is the new primitive: it stops a row being
 *                                  listed in a scope where some members cannot
 *                                  see it.
 *
 * Failure of (3) is NOT a dead end: it OFFERS the #1437 row-promotion request
 * as the recourse (never widen silently). The offer names the visibility the
 * row must reach for the scope to see it, in the vocabulary the #1437 flow
 * accepts ("team" | "organization"); scopes that flow cannot satisfy (a user
 * or project scope — the row would need a project refinement / another user's
 * grant, not a visibility widen) get a null offer (still fail-closed — the
 * denial stands, there is simply no #1437-shaped recourse).
 *
 * Evaluation ORDER is load-bearing: actor-see → actor-write-scope →
 * scope-see. The scope-see failure (and its promotion offer, which reveals the
 * row exists and is promotable) is only surfaced once the actor has both read
 * access to the row AND write access to the scope — never to a principal with
 * no business adding to the scope.
 *
 * PURE: no I/O. The consumer resolves the row's ownership tuple and its own
 * scope-write decision, then calls this to compose the verdict + recourse.
 */

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  actorMaySeeRow,
  scopeMaySeeRow,
  type CollectionScope,
  type OwnershipEvalRow,
} from "@/lib/derived-store-ownership";
import type { ArtifactPromotionVisibility } from "@/lib/objects/artifact-promotion-request-store";
import { isWiden } from "@/lib/objects/promotion-visibility-lattice";

export type { CollectionScope, OwnershipEvalRow };

/** The row being added — its canonical ownership tuple plus its id. */
export type CollectionAddRow = OwnershipEvalRow & { id: string };

/**
 * A ready-to-submit #1437 promotion request the caller can offer as the
 * recourse when the scope cannot yet see the row. Shaped to feed
 * `requestArtifactPromotion` directly (artifactId + toVisibility + optional
 * targetTeamId).
 */
export type CollectionAddPromotionOffer = {
  artifactId: string;
  /** The visibility the row must reach for the scope to see it. */
  toVisibility: ArtifactPromotionVisibility;
  /** Present iff `toVisibility === "team"` — the scope's team. */
  targetTeamId?: string;
};

export type CollectionAddDenialReason =
  | "actor_cannot_see_row"
  | "actor_cannot_write_scope"
  | "scope_cannot_see_row";

export type CollectionAddDecision =
  | { ok: true }
  | {
      ok: false;
      reason: CollectionAddDenialReason;
      /**
       * The #1437 promotion recourse — present (possibly non-null) ONLY for a
       * `scope_cannot_see_row` denial; `null` when the scope kind has no
       * #1437-shaped recourse. Always `null` for the other denial reasons.
       */
      promotion: CollectionAddPromotionOffer | null;
    };

export type AuthorizeCollectionAddInput = {
  /** The acting principal. */
  actor: ActorContext;
  /** The scope whose collection the row would be added to. */
  scope: CollectionScope;
  /** The row being added (canonical ownership tuple + id). */
  row: CollectionAddRow;
  /**
   * The consumer's "may this actor write the scope's collection" decision.
   * REQUIRED — the contract does not guess a scope-write model (B4/#1897 owns
   * it). Pass the result of the collection surface's own authorization.
   */
  actorMayWriteScope: boolean;
};

/** The scope's org, or null for a scope with no resolvable tenancy. */
function scopeOrgId(scope: CollectionScope): string | null {
  switch (scope.kind) {
    case "user":
      return scope.orgId ?? null;
    case "team":
    case "organization":
    case "workspace":
    case "project":
      return scope.orgId ?? null;
    default:
      return null;
  }
}

/**
 * Compute the #1437 promotion offer that would make `scope` able to see a row
 * it currently cannot — but ONLY a GENUINE, same-tenant #1437 widen the flow
 * would accept (codex convergence: a naive offer that ignores the row's current
 * visibility, tenant, or scope validity is a dead recourse, not a real one). An
 * offer is emitted iff:
 *
 *   1. TENANT — the row lives in the scope's own org. A foreign-org row can
 *      never be promoted into this scope's tenant (cross-org is neither a widen
 *      nor tenant-valid).
 *   2. WIDEN  — the offered target strictly widens the row's CURRENT visibility
 *      (`isWiden`), so #1437 accepts it (no team→team no-op, no
 *      public→organization narrowing).
 *   3. SCOPE-SATISFYING target, by scope kind:
 *        - team              → widen to "team" owned by the scope's (valid) team
 *                              (only from a tighter-than-team current, e.g.
 *                              private); the widened row then lands team-visible.
 *        - organization /
 *          workspace         → widen to "organization" (org-wide readers see it).
 *        - user / project    → null: the row would need another user's grant or
 *                              a project refinement, which #1437 does not do.
 *
 * Otherwise `null` — the denial still stands (fail-closed); there is simply no
 * #1437-shaped recourse to offer.
 *
 * This is the ACTOR-LESS core (tenant + widen + scope-satisfying target). It
 * does NOT verify the requester's team MEMBERSHIP, which a #1437 team target
 * also requires — the contract applies that gate in `liveOfferForActor` using
 * the actor's own team grants. Prefer `authorizeCollectionAdd` (which composes
 * both) over calling this directly.
 */
export function promotionOfferForScope(
  scope: CollectionScope,
  row: CollectionAddRow,
): CollectionAddPromotionOffer | null {
  // 1. Tenant equality — no cross-org promotion into this scope.
  const org = scopeOrgId(scope);
  if (!org || row.orgId !== org) return null;

  switch (scope.kind) {
    case "team": {
      // 2/3. team target must be a REAL team AND a strict widen (e.g. a private
      // row → team). A row already at team+ visibility does not widen to "team".
      if (!scope.teamId) return null;
      if (!isWiden(row.visibility ?? "", "team")) return null;
      return { artifactId: row.id, toVisibility: "team", targetTeamId: scope.teamId };
    }
    case "organization":
    case "workspace": {
      if (!isWiden(row.visibility ?? "", "organization")) return null;
      return { artifactId: row.id, toVisibility: "organization" };
    }
    case "user":
    case "project":
      return null;
    default:
      return null;
  }
}

/**
 * The collection-add authorization contract — see the module header. Pure;
 * returns `{ ok: true }` or a structured denial (with the #1437 promotion
 * recourse on a scope-visibility failure).
 */
export function authorizeCollectionAdd(
  input: AuthorizeCollectionAddInput,
): CollectionAddDecision {
  const { actor, scope, row, actorMayWriteScope } = input;

  // 1. actor-may-see — never act on (or reveal) a row the actor cannot open.
  if (!actorMaySeeRow(actor, row)) {
    return { ok: false, reason: "actor_cannot_see_row", promotion: null };
  }

  // 2. actor-may-write-scope — the consumer's collection-write authorization.
  if (!actorMayWriteScope) {
    return { ok: false, reason: "actor_cannot_write_scope", promotion: null };
  }

  // 3. scope-vantage guard — the row must be visible to the WHOLE scope, else
  //    offer the #1437 promotion recourse (never widen silently). The offer is
  //    actor-gated so it names ONLY a request THIS actor could actually submit
  //    (see `liveOfferForActor`).
  if (!scopeMaySeeRow(scope, row)) {
    return {
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: liveOfferForActor(actor, scope, row),
    };
  }

  return { ok: true };
}

/**
 * The tenant+widen-valid offer (`promotionOfferForScope`), FURTHER gated on
 * whether THIS actor could submit it, so the contract never surfaces a dead
 * recourse (codex convergence). A #1437 TEAM-target request additionally
 * requires the requester to be a MEMBER of the target team
 * (`createArtifactRowPromotionRequest` refuses a non-member with `invalid_state`
 * — artifact-row-promotion.ts). The actor-less core cannot know that; here we
 * do, from `actor.teamIds`. A team offer for a non-member (e.g. an org admin who
 * may write the collection but is not in the team) is therefore withheld — the
 * denial still stands, there is simply no team-target recourse for that actor.
 * (#1437 remains the fail-closed enforcement point; this only avoids offering a
 * request that would bounce.)
 */
function liveOfferForActor(
  actor: ActorContext,
  scope: CollectionScope,
  row: CollectionAddRow,
): CollectionAddPromotionOffer | null {
  const offer = promotionOfferForScope(scope, row);
  if (offer && offer.toVisibility === "team") {
    const isMember = (actor.teamIds ?? []).includes(offer.targetTeamId ?? "");
    if (!isMember) return null;
  }
  return offer;
}
