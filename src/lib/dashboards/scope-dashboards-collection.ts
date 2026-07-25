/**
 * The scope Dashboards tab — PURE collection model (cinatra#1897 B4; the ratified
 * design spec at design@0ead5d0c5, `specs/app-artifacts.html` §IX / §IX.1).
 *
 * No I/O. Given the acting principal, the scope, the scope-write decision and a
 * pool of candidate dashboards (each with its CANONICAL ownership tuple, sourced
 * from the objects twin — the substrate that carries the canonical visibility),
 * this composes the landed collection-add contract (`authorizeCollectionAdd`,
 * cinatra#1886) into the add-picker model §IX.1 renders:
 *
 *   - ADDABLE          — the contract returns `{ ok: true }`: the actor may see
 *                        it AND the scope may already see it (both reads pass);
 *                        the row offers a direct Add.
 *   - PROMOTION OFFER  — the contract denies with `scope_cannot_see_row` AND a
 *                        non-null #1437 recourse: the actor could widen the row's
 *                        visibility so the scope can see it (team / organization).
 *                        The row offers the promotion REQUEST, never an in-place
 *                        add (never widen silently).
 *   - NOT ADDABLE      — the contract denies with `scope_cannot_see_row` and a
 *                        NULL recourse (a project tab — a project is a resource
 *                        refinement, not a visibility tier, so no widen applies),
 *                        or any other denial: the row states plainly it is not
 *                        addable, with no offer (fail-closed).
 *
 * The evaluation ORDER and the "recourse only on the scope-see failure (gates
 * 1–2 having passed)" rule are the contract's — this module does not re-derive
 * them, it renders them. The picker is only shown to a writer (gate 2 has
 * passed) over an actor-visible pool (gate 1 has passed), so in practice a
 * candidate lands ADDABLE or (scope-invisible) PROMOTION/NOT-ADDABLE.
 */
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  authorizeCollectionAdd,
  type CollectionAddRow,
  type CollectionScope,
} from "@/lib/objects/collection-add-authorization";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";

/**
 * Map a Dashboards-tab `ListingScope` onto the collection-add contract's
 * `CollectionScope`. The three shared scopes only (§IX):
 *   - team         → { kind:'team', teamId, orgId }
 *   - organization → { kind:'organization', orgId }        (orgId === scopeId)
 *   - project      → { kind:'project', projectId, orgId }
 */
export function toCollectionScope(scope: ListingScope): CollectionScope {
  switch (scope.kind) {
    case "team":
      return { kind: "team", teamId: scope.scopeId, orgId: scope.orgId };
    case "organization":
      return { kind: "organization", orgId: scope.scopeId };
    case "project":
      return { kind: "project", projectId: scope.scopeId, orgId: scope.orgId };
    default: {
      const _exhaustive: never = scope.kind;
      return _exhaustive;
    }
  }
}

/** A candidate the picker evaluates — its CANONICAL ownership tuple (from the
 *  objects twin) plus display fields. */
export type ScopeAddCandidate = CollectionAddRow & {
  /** Display name. */
  readonly name: string;
  /** The candidate's own canonical home, entity-named (e.g. "Team: Growth-EMEA")
   *  — the meta line the picker shows over the visibility note. */
  readonly homeLabel: string | null;
};

/** The picker's per-candidate disposition — the three §IX.1 outcomes. */
export type PickerDisposition =
  | { readonly kind: "addable" }
  | {
      readonly kind: "promotion";
      readonly toVisibility: "team" | "organization";
      readonly targetTeamId?: string;
    }
  | { readonly kind: "not-addable" };

export type PickerCandidateModel = {
  readonly dashboardId: string;
  readonly name: string;
  readonly homeLabel: string | null;
  readonly disposition: PickerDisposition;
};

/**
 * Build the add-picker model: one disposition per candidate, via the contract.
 * `actorMayWriteScope` is the injected gate-2 decision (from
 * `actorMayWriteScope(actor, scope)`), threaded verbatim into the contract so
 * the picker's verdict is the SAME conjunction the mutation enforces (no
 * render/enforce drift).
 */
export function buildAddPickerModel(input: {
  actor: ActorContext;
  scope: ListingScope;
  actorMayWriteScope: boolean;
  candidates: readonly ScopeAddCandidate[];
}): PickerCandidateModel[] {
  const collectionScope = toCollectionScope(input.scope);
  return input.candidates.map((c) => {
    const decision = authorizeCollectionAdd({
      actor: input.actor,
      scope: collectionScope,
      row: c,
      actorMayWriteScope: input.actorMayWriteScope,
    });
    return {
      dashboardId: c.id,
      name: c.name,
      homeLabel: c.homeLabel,
      disposition: dispositionOf(decision),
    };
  });
}

function dispositionOf(
  decision: ReturnType<typeof authorizeCollectionAdd>,
): PickerDisposition {
  if (decision.ok) return { kind: "addable" };
  if (decision.reason === "scope_cannot_see_row" && decision.promotion) {
    return {
      kind: "promotion",
      toVisibility: decision.promotion.toVisibility,
      ...(decision.promotion.targetTeamId
        ? { targetTeamId: decision.promotion.targetTeamId }
        : {}),
    };
  }
  // scope_cannot_see_row with a null recourse (project scope), or any other
  // denial → not addable, no offer (fail-closed).
  return { kind: "not-addable" };
}

/**
 * The SERVER-side authorization for an add mutation — the SAME contract, returned
 * as a structured verdict the action maps to a typed result. Kept here (pure) so
 * the mutation gate and the picker model share one evaluation.
 */
export function authorizeScopeAdd(input: {
  actor: ActorContext;
  scope: ListingScope;
  actorMayWriteScope: boolean;
  row: CollectionAddRow;
}): ReturnType<typeof authorizeCollectionAdd> {
  return authorizeCollectionAdd({
    actor: input.actor,
    scope: toCollectionScope(input.scope),
    row: input.row,
    actorMayWriteScope: input.actorMayWriteScope,
  });
}
