/**
 * Pending-approval HITL recovery state.
 *
 * THE INVARIANT this module serves: a run parked on `pending_approval` must
 * expose an inline action OR an explicit recovery/error state. The run panel
 * keys its inline gate rendering on a derived HITL context (`xRenderer` +
 * `reviewTaskId`). The server ALWAYS synthesizes that context for a paused run
 * (`deriveRunHitlContext` — synthetic `wayflow-<taskId>` / `setup-<runId>`
 * identities), so a client that holds `null` did not get told "there is no
 * gate": it got told nothing at all. Both hydration transports swallow that
 * silence today (a rejected fetch, a non-ok response, and a snapshot that
 * carries an error instead of a status all leave the previous `null` in place),
 * which is exactly how a paused run can present a banner with no control on it.
 *
 * This module is the pure book-keeping for that: it classifies each hydration
 * attempt, counts attempts and failures, and answers the two questions the
 * panel asks — "may I show the recovery state?" and "may I log the invariant
 * violation?". Both answers are deliberately BOUNDED: `hitlContext` starts null
 * and hydrates a tick later on every healthy run, so an unbounded predicate
 * would report every normal page load.
 *
 * PURITY CONTRACT: no React, no `"use client"`, no host `@/` imports — only
 * plain data in, plain data out. Mirrors `run-surface-status.ts` /
 * `hitl-gate-submit.ts`.
 */

/** The outcome of ONE derived-context hydration attempt. */
export type HitlDerivationOutcome =
  /** A usable gate context arrived. */
  | { kind: "context" }
  /** Transport answered, and the run is not parked on a gate any more. */
  | { kind: "resolved" }
  /**
   * Transport answered "still pending_approval" but carried NO gate context.
   * This is a server-side derivation failure on the wire: the derivation
   * contract says a paused run always yields a context.
   */
  | { kind: "derivation_failed"; reason: string }
  /** The transport itself failed (rejected fetch, non-ok status, error snapshot). */
  | { kind: "transport_failed"; reason: string };

export type HitlDerivationFailure = {
  scope: "derivation" | "transport";
  reason: string;
};

export type HitlDerivationState = {
  /** Hydration attempts that produced a classified outcome. */
  attempts: number;
  /** Consecutive attempts that failed to yield a usable context. */
  consecutiveFailures: number;
  /** The most recent failure, or null once a context arrives. */
  lastFailure: HitlDerivationFailure | null;
};

export const INITIAL_HITL_DERIVATION_STATE: HitlDerivationState = {
  attempts: 0,
  consecutiveFailures: 0,
  lastFailure: null,
};

/**
 * Attempts tolerated before a context-less paused run is treated as degraded.
 * The panel polls a paused run every 5s, so this is ~15s of normal hydration
 * headroom — long enough that a healthy first paint never trips it, short
 * enough that a genuinely stranded run gets its escape hatch quickly.
 */
export const HITL_RECOVERY_MIN_ATTEMPTS = 3;

/**
 * Classify one hydration answer. `status` is the run status the transport
 * reported (null when it carried none), `context` the gate context it carried.
 */
export function classifyHitlDerivation(
  status: string | null,
  context: unknown,
  /**
   * IS THIS PAUSE THE REVIEW OF WHAT THE RUN PRODUCED? (cinatra#3007.)
   *
   * The derivation contract this module opens with — "a paused run always
   * yields a context" — was true of every pause that existed when it was
   * written, and cinatra#3007 added one it is not true of. A run held for the
   * review of its own output waits in `pending_approval` with NO approval step
   * at all: the hold withholds the run's terminal write instead of minting a
   * gate for anybody to answer. So for THAT pause "paused, and no context" is
   * the ordinary reading and not a failure on the wire, and calling it a
   * failure is conclusive on its first occurrence — which is how the run page
   * came to draw "its approval step could not be loaded" with a Re-check beside
   * it, on the very first tick of a park that was working exactly as designed.
   *
   * Absent (the default), every existing caller is classified byte-for-byte as
   * it was.
   */
  parkedOnProducedReview: boolean = false,
): HitlDerivationOutcome {
  if (context) return { kind: "context" };
  if (status === "pending_approval") {
    if (parkedOnProducedReview) return { kind: "resolved" };
    return {
      kind: "derivation_failed",
      reason: "the server reported this run as paused but sent no approval step",
    };
  }
  return { kind: "resolved" };
}

/**
 * Fold one outcome into the running state. A successful context RESETS the
 * failure book-keeping: recovery is about the CURRENT stranding, never about a
 * blip the run already recovered from.
 */
export function reduceHitlDerivation(
  state: HitlDerivationState,
  outcome: HitlDerivationOutcome,
): HitlDerivationState {
  const attempts = state.attempts + 1;
  if (outcome.kind === "context" || outcome.kind === "resolved") {
    return { attempts, consecutiveFailures: 0, lastFailure: null };
  }
  return {
    attempts,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailure: {
      scope: outcome.kind === "derivation_failed" ? "derivation" : "transport",
      reason: outcome.reason,
    },
  };
}

/**
 * May the panel show the explicit recovery state?
 *
 * Only for a paused run that currently has NO usable context, and only once we
 * have a REASON to call it degraded: either an observed failure (server-side
 * derivation failure or a dead transport — both are conclusive on their first
 * occurrence) or enough silent attempts to rule out normal hydration.
 */
export function isHitlRecoveryVisible(input: {
  isPendingApproval: boolean;
  hasContext: boolean;
  state: HitlDerivationState;
  /** Is this pause the review of what the run produced — or the window before
   *  the surface has heard which pause it is? See the note above the
   *  classifier: neither is a run with a step that failed to load. */
  isProducedReviewPark?: boolean;
}): boolean {
  if (!input.isPendingApproval || input.hasContext) return false;
  if (input.isProducedReviewPark) return false;
  if (input.state.lastFailure !== null) return true;
  return input.state.attempts >= HITL_RECOVERY_MIN_ATTEMPTS;
}

/** Reader-facing explanation of the current recovery state. */
export function hitlRecoveryReason(state: HitlDerivationState): string {
  if (state.lastFailure) return state.lastFailure.reason;
  return "the approval step for this run did not load";
}

/**
 * The bounded telemetry predicate. Returns the payload to log ONCE per
 * stranded run, or null when the invariant is intact or still hydrating.
 * Same bound as the recovery state — never fires on normal hydration.
 */
export function describeHitlInvariantViolation(input: {
  isPendingApproval: boolean;
  hasContext: boolean;
  state: HitlDerivationState;
  /** Carried through to the predicate below — a park is not a violation. */
  isProducedReviewPark?: boolean;
}): {
  attempts: number;
  consecutiveFailures: number;
  failureScope: "derivation" | "transport" | "none";
  reason: string;
} | null {
  if (!isHitlRecoveryVisible(input)) return null;
  return {
    attempts: input.state.attempts,
    consecutiveFailures: input.state.consecutiveFailures,
    failureScope: input.state.lastFailure?.scope ?? "none",
    reason: hitlRecoveryReason(input.state),
  };
}
