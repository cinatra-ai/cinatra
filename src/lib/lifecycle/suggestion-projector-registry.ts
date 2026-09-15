// THE SUGGESTION PROJECTOR A KIND DECLARES (enabler 0.15 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3028 / epic #3023 — the projector half
// of cinatra#2950).
//
// THE PLAN'S SENTENCE, VERBATIM: "The suggestion projector, declared by the
// kind: an artifact extension may declare, beside its display, a suggestion
// projector for its type; the host resolves it by kind when it opens a gate — on
// the single-artifact path and the batch path alike — and a kind without one
// yields no suggestions, recorded as such."
//
// WHAT IT FIXES, VERBATIM: "the production auto-gate hands the suggestion lane
// the identity-only projector and the batch path skips the lane, so a real gate
// normally has no suggestion snapshot; NO KIND-TO-PROJECTOR RESOLVER EXISTS; and
// the producer's single-target snapshot makes a second target return
// already-bound — the drawn suggestion states cannot arise on a real run."
//
// WHY A REGISTRY AND NOT A LOOKUP IN THE LANE. "Beside its display" is the
// shape: an extension's display is registered at boot or install and resolved by
// type, and the projector is declared the same way and resolved the same way, so
// one extension's declaration cannot be read by a host module enumerating
// extensions it knows about. The registrar that registers displays registers
// these; this module is only the resolution.
//
// PURE, and process-scoped exactly like the renderer registries beside it. A
// projector is a FUNCTION over a disclosed projection, never a fetch: it turns
// the pinned revision the host disclosed into flat fields, and the deterministic
// rule engine does the rest.

import type {
  CoreAnalysisAuthzDecision,
  CoreAnalysisProjection,
  CoreAnalysisTarget,
} from "./lifecycle-core-analysis";

/**
 * What a kind's projector does: turn ONE pinned target into the disclosure the
 * deterministic rule engine runs over.
 *
 * It receives what the HOST decided to disclose about the target — never a
 * connection, never a fetch — so a projector can only ever propose over text it
 * was shown. That is the same contract the lane's injectable `SuggestionProjector`
 * already carries; this is the per-kind resolution of it.
 */
export type KindSuggestionProjector = (
  target: CoreAnalysisTarget,
) =>
  | Promise<{ projection: CoreAnalysisProjection; authzDecision: CoreAnalysisAuthzDecision }>
  | { projection: CoreAnalysisProjection; authzDecision: CoreAnalysisAuthzDecision };

/** One kind's declared projector. */
export interface SuggestionProjectorDescriptor {
  /** The object type the projector is declared for — the kind. */
  typeId: string;
  /**
   * The projector's stable id, recorded on every snapshot entry it produces.
   * `<extension>#<name>`, so a stored payload names WHICH declaration produced
   * it and a reader can tell a re-declared projector from the original.
   */
  projectorId: string;
  /** The projector for this org, built per resolution — the disclosure is
   *  organization-scoped, so the factory takes the organization. */
  create(orgId: string): KindSuggestionProjector;
}

const registry = new Map<string, SuggestionProjectorDescriptor>();

/**
 * Register a kind's declared suggestion projector.
 *
 * ONE LIVE DECLARATION PER KIND, like the display registration beside it: a
 * second registration for the same type REPLACES the first rather than
 * accumulating, so resolution is total and a reinstall does not leave two
 * projectors racing for one gate.
 */
export function registerSuggestionProjector(descriptor: SuggestionProjectorDescriptor): void {
  registry.set(descriptor.typeId, descriptor);
}

/**
 * Resolve the projector a kind declared. NULL when the kind declares none —
 * which is an answer, not a failure: the plan's "a kind without one yields no
 * suggestions, recorded as such", and the snapshot records the null beside the
 * empty set.
 */
export function resolveSuggestionProjectorForKind(
  typeId: string,
): SuggestionProjectorDescriptor | null {
  return registry.get(typeId) ?? null;
}

/** Every registered kind, for the readiness counting the plan's gates do. */
export function listRegisteredSuggestionProjectorKinds(): string[] {
  return [...registry.keys()].sort();
}

/** Test seam: drop every registration. Never called by product code. */
export function __clearSuggestionProjectorsForTest(): void {
  registry.clear();
}
