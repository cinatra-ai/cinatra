/**
 * THE MARKED REVIEW STEP'S TARGET SET (cinatra#3035, epic #3023 W11; plan (C)
 * §6.1 step 4, §8.4 "the runtime and the flows").
 *
 * Two pure decisions the run executor used to make inline, and could not be
 * tested making:
 *
 *   WHERE THE SET COMES FROM. "The pipeline's gate names the post's reference
 *   and each picture's reference — immutable revision references the materialize
 *   step and the image tool returned, gathered by a projection step into the
 *   input the review marker points at." Those references are minted DURING the
 *   run, so the value that matters is the one the gate's own pause carries, not
 *   the one the run started with. The executor's earlier `startParams[name] ??
 *   pausePayload[name]` read the two in the opposite order, and `??` falls
 *   through only on null/undefined — so a flow that also lists the marked input
 *   on its start node (every compiled flow does: a node input is a flow input,
 *   and the compiler gives it a default) shadowed the run's own projection with
 *   `[]` or `""` and the gate pinned nothing. A gate whose set really is
 *   resolved at run start keeps working: the start value is the fallback.
 *
 *   HOW MANY REVIEWS IT OPENS. "One review per artifact — the post's on its
 *   immutable reference, then each picture's on its own; the run parks at each."
 *   A set naming three artifacts is three reviews in order, never one combined
 *   review over the set.
 *
 * PURE — no database, no React, no `server-only` — so the run executor can call
 * it without pulling either into its reachable graph, exactly as
 * `lifecycle-review-core.ts` is pure for the same reason.
 */

import {
  parseArtifactReviewTarget,
  type ArtifactReviewTarget,
} from "@/lib/artifacts/artifact-review-target";

/** One review leg: the gate it is pinned under, and the one artifact it shows. */
export interface PlannedReviewGate {
  readonly reviewTaskId: string;
  readonly targets: readonly [ArtifactReviewTarget];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this value a set a gate could pin?
 *
 * Deliberately weaker than `normalizeReviewTargets`: this predicate only decides
 * WHICH of the two candidate values the executor hands to the review core, and
 * the core is the one place allowed to reject a set. Anything present and
 * non-empty is a candidate; `undefined`, `null`, `""` and `[]` are the compiler's
 * defaults for an input nothing wrote, and mean "this side named nothing".
 */
function namesSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Resolve the raw value of the input a gate's `cinatra.artifactReview.targetsInput`
 * marker names, preferring the run's own mid-run projection.
 *
 * Returns the raw value — a JSON string is parsed, because an InputMessageNode
 * carries one string — and `undefined` when neither side named the input, which
 * is what the review core reads as "the review step names no usable artifact".
 */
export function resolveDeclaredReviewTargets(input: {
  readonly inputName: string;
  readonly startParams: Record<string, unknown> | null | undefined;
  readonly pausePayload: Record<string, unknown> | null | undefined;
}): unknown {
  const fromPause = input.pausePayload?.[input.inputName];
  const fromStart = input.startParams?.[input.inputName];
  const chosen = namesSomething(fromPause)
    ? fromPause
    : namesSomething(fromStart)
      ? fromStart
      : undefined;
  if (chosen === undefined) return undefined;
  if (typeof chosen === "string") {
    try {
      return JSON.parse(chosen) as unknown;
    } catch {
      // Not JSON: hand the raw string on. The core refuses it with a stated
      // reason, which is the same answer this function would have to invent.
      return chosen;
    }
  }
  return chosen;
}

/**
 * One review per artifact, in the order the set names them.
 *
 * The FIRST artifact keeps the gate's own task id, so a set that names one
 * artifact plans exactly the gate that already exists and no run in flight is
 * re-keyed; every further artifact gets a suffixed id of its own. An artifact
 * named twice — a picture regenerated inside the same set — is one review on its
 * first-named revision, because a review is per artifact and the core has
 * already frozen which revision that is.
 *
 * A malformed element is dropped here rather than rejecting the set: the core
 * validated the set before it reached this planner, so anything that fails to
 * parse at this point cannot be pinned by anyone and dropping it leaves the
 * reviews that CAN open still open.
 */
export function planPerArtifactReviewGates(input: {
  readonly reviewTaskId: string;
  readonly targets: unknown;
}): PlannedReviewGate[] {
  const raw = Array.isArray(input.targets) ? input.targets : [];
  const planned: PlannedReviewGate[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const target = parseArtifactReviewTarget(candidate);
    if (!target) continue;
    if (seen.has(target.artifactId)) continue;
    seen.add(target.artifactId);
    planned.push({
      reviewTaskId:
        planned.length === 0 ? input.reviewTaskId : `${input.reviewTaskId}#${planned.length + 1}`,
      targets: [target],
    });
  }
  return planned;
}

/** A gate as this module needs to read it: which review it is, and whether it
 *  has been decided. */
export interface ReviewLegState {
  readonly reviewTaskId: string;
  readonly status: string;
}

/**
 * The WayFlow task id a leg's gate belongs to.
 *
 * A leg id is the gate's own id with `#n` appended for every artifact after the
 * first. A WayFlow task id is an opaque store id that never carries `#`, so the
 * first `#` is an unambiguous boundary and a gate with no suffix is its own base.
 */
export function baseReviewTaskId(reviewTaskId: string): string {
  const cut = reviewTaskId.indexOf("#");
  return cut === -1 ? reviewTaskId : reviewTaskId.slice(0, cut);
}

/**
 * Is another artifact of this same review still waiting to be read?
 *
 * "The run parks at each." One WayFlow pause carries one review per artifact, so
 * the run may only go on when the LAST of them is decided — the resume of an
 * earlier leg leaves the run where it is and the person is sent to the next leg.
 * The leg being asked about is excluded: it is the one whose decision is landing.
 */
export function hasPendingSiblingLeg(input: {
  readonly reviewTaskId: string;
  readonly gates: readonly ReviewLegState[];
}): boolean {
  const base = baseReviewTaskId(input.reviewTaskId);
  return input.gates.some(
    (gate) =>
      gate.reviewTaskId !== input.reviewTaskId &&
      baseReviewTaskId(gate.reviewTaskId) === base &&
      gate.status !== "resolved",
  );
}

/**
 * The leg a person is sent to now: the first planned one that is not resolved.
 *
 * A leg with no gate row yet counts as unresolved — it is the next one to pin —
 * so the walk is over the PLAN, in the order the set named the artifacts, and
 * the gates only say which of them are already done.
 */
export function nextUnresolvedLeg(input: {
  readonly planned: readonly PlannedReviewGate[];
  readonly gates: readonly ReviewLegState[];
}): PlannedReviewGate | null {
  for (const leg of input.planned) {
    const gate = input.gates.find((g) => g.reviewTaskId === leg.reviewTaskId);
    if (!gate || gate.status !== "resolved") return leg;
  }
  return null;
}
