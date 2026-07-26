/**
 * The typed CONTINUATION contract (cinatra#2038, epic #2037 S0).
 *
 * When a checkpoint's policy FIRES, how the producing run continues depends on
 * the continuation mode declared on the produced event:
 *
 *   CHECKPOINTED (evaluate-then-park) — a SYNCHRONOUS policy check happens BEFORE
 *     the run parks: a checkpoint the policy SKIPS never parks (the run proceeds);
 *     a checkpoint the policy FIRES parks with the policy-decision id on the park
 *     record. A durable BYPASS-RESUME intent + a sweeper release the park when the
 *     decision resolves. Unevaluable policy parks WITH a reevaluation intent, and
 *     its TTL ALWAYS resumes — leaving the protected effect in a terminal
 *     `policy_unresolved` blocked state (ops-surfaced), never a silently
 *     abandoned strand.
 *
 *   ASYNC EFFECTS-GATED — the run NEVER pauses retroactively; the artifact's
 *     typed downstream EFFECTS (external publish/apply, visibility promotion,
 *     pipeline hand-off) are HELD until the decision. This is the standard mode
 *     (epic decision 3); checkpointed parking is per-flow opt-in.
 *
 * PURE: the evaluate-then-park DECISION + the park-resolution transitions are a
 * total function; the durable park record + the sweeper live in
 * `packages/agents/src/lifecycle-continuation-park-store.ts`.
 */

import type { LifecycleCheckpoint, PolicyDecision, DestinationClass } from "./lifecycle-policy";

// ---------------------------------------------------------------------------
// Effect classes held by the async effects-gated mode.
// ---------------------------------------------------------------------------

/** The typed effect classes an async effects-gated continuation holds until the
 * decision. Mirrors the external-effect destination classes; `none` carries no
 * held effect. */
export type HeldEffectClass = Exclude<DestinationClass, "none">;

// ---------------------------------------------------------------------------
// Evaluate-then-park (the checkpointed-mode synchronous decision).
// ---------------------------------------------------------------------------

/** The park state a checkpointed run enters (or does not) after the synchronous
 * policy check. */
export type ParkStatus = "parked" | "released" | "policy_unresolved";

/** The outcome of the pre-park synchronous evaluation. Either the run PROCEEDS
 * (never parks) or it PARKS with the deciding policy id + a reevaluation intent
 * when the policy was unevaluable. */
export type EvaluateThenParkOutcome =
  | {
      kind: "proceed";
      /** Why the run does not park: the policy skipped, forbade, or (non-external)
       * left the checkpoint ungated. */
      reason: string;
    }
  | {
      kind: "park";
      checkpoint: LifecycleCheckpoint;
      /** The protected effect the park guards (drives the TTL fail-closed). */
      protectedEffect: DestinationClass;
      /** True when the policy was unevaluable (external-effect `policy_unresolved`)
       * — the park carries a REEVALUATION intent and its TTL resolves to a terminal
       * `policy_unresolved` block, never an indefinite park. */
      reevaluationIntent: boolean;
      reason: string;
    };

/**
 * The evaluate-then-park decision for a CHECKPOINTED run: given the lattice
 * verdict for a checkpoint, decide whether the run parks. A `skip`/`forbidden`
 * verdict PROCEEDS (never parks — the AC invariant); a `required`/`fire` verdict
 * PARKS; a `policy_unresolved` verdict parks WITH a reevaluation intent (its TTL
 * fail-closes the protected effect). Pure.
 */
export function evaluateThenPark(
  decision: PolicyDecision,
  input: { checkpoint: LifecycleCheckpoint; destinationClass: DestinationClass },
): EvaluateThenParkOutcome {
  if (decision.outcome === "policy_unresolved") {
    return {
      kind: "park",
      checkpoint: input.checkpoint,
      protectedEffect: input.destinationClass,
      reevaluationIntent: true,
      reason: decision.reason,
    };
  }
  if (!decision.fired) {
    // skip / forbidden — a checkpointed run whose policy says skip NEVER parks.
    return { kind: "proceed", reason: decision.reason };
  }
  return {
    kind: "park",
    checkpoint: input.checkpoint,
    protectedEffect: input.destinationClass,
    reevaluationIntent: false,
    reason: decision.reason,
  };
}

// ---------------------------------------------------------------------------
// Park resolution transitions (what the sweeper applies).
// ---------------------------------------------------------------------------

/** The signal that resolves a parked checkpoint. */
export type ParkResolution =
  /** A decision resolved the gate to FIRE/effect-release — release the park and
   * let the protected effect through. */
  | { kind: "released" }
  /** A decision resolved the gate to SKIP — release the park; the checkpoint no
   * longer applies. */
  | { kind: "resolved_skip" }
  /** The park TTL expired before any decision — always-resume, leaving the
   * protected effect terminally blocked. */
  | { kind: "ttl_expired" };

export type ParkTransition =
  | { status: "released"; effectBlocked: false; reason: string }
  | { status: "policy_unresolved"; effectBlocked: true; reason: string };

/**
 * Apply a resolution to a parked checkpoint → its terminal transition. Pure.
 *
 *   released / resolved_skip → the park is released and the effect is NOT blocked
 *     (a resolved-skip means the checkpoint no longer gates the effect at all).
 *   ttl_expired → the park always-resumes into a terminal `policy_unresolved`
 *     block on the protected effect (fail-closed, ops-surfaced) — this is the
 *     ONLY path that blocks an effect, and only for an unevaluable park.
 */
export function resolvePark(resolution: ParkResolution): ParkTransition {
  switch (resolution.kind) {
    case "released":
      return { status: "released", effectBlocked: false, reason: "decision released the gate" };
    case "resolved_skip":
      return {
        status: "released",
        effectBlocked: false,
        reason: "decision resolved the checkpoint to skip",
      };
    case "ttl_expired":
      return {
        status: "policy_unresolved",
        effectBlocked: true,
        reason: "park TTL expired with policy unevaluable — effect blocked pending an explicit decision",
      };
    default: {
      const _exhaustive: never = resolution;
      void _exhaustive;
      return {
        status: "policy_unresolved",
        effectBlocked: true,
        reason: "unknown resolution — fail closed",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Forced-strand guard.
// ---------------------------------------------------------------------------

/** Whether a park may be TORN DOWN (stranded) without a resolution. A park that
 * is still `parked` and NOT past its TTL may NEVER be stranded — every park must
 * terminate through `resolvePark` (released or the TTL fail-closed block). Only an
 * already-terminal park (released / policy_unresolved) is strippable. The store's
 * strand attempt calls this and refuses on `false`. */
export function isStrandable(park: { status: ParkStatus }): boolean {
  return park.status === "released" || park.status === "policy_unresolved";
}
