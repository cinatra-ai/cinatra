/**
 * The ONE live-attempt predicate — cinatra#1938 (archive epic S2).
 *
 * Both consumers evaluate exactly this function, so they can never diverge
 * (codex-converged r1):
 *   - archive-lease snapshot eligibility ("which in-flight runs get a bounded
 *     window when the org archives");
 *   - run-authority minting (`verifyRunAuthority` refuses a VerifiedRunRef for
 *     anything that fails it).
 *
 * pending_input is ambiguous by construction: it is entered both pre-dispatch
 * (setup, resets — `failed→pending_input` RETAINS the stale attempt id) and
 * in-flight (a genuine human wait inside a live attempt). The durable
 * discriminator is `human_wait_attempt_id`: stamped with the CURRENT
 * execution_attempt_id exactly on the one human-wait `running→pending_input`
 * transition, cleared on every other `→pending_input` edge and on every
 * dispatch. A reset run therefore fails the equality below and is treated as
 * pre-dispatch — fail-closed.
 */

/** Run statuses that are live unconditionally (dispatch happened, work or an
 *  approval is genuinely in flight). Pre-dispatch/gated states (pending_trigger,
 *  armed, setup-phase pending_input) and terminal states are NOT here. */
const UNCONDITIONALLY_LIVE = new Set(["queued", "running", "pending_approval"]);

export interface LiveAttemptRow {
  readonly status: string;
  readonly executionAttemptId: string | null;
  readonly executionDeadlineAt: Date | string | null;
  readonly humanWaitAttemptId: string | null;
}

export interface LiveAttemptClock {
  /** "now" — passed in so the predicate stays pure and unit-testable. */
  readonly nowMs: number;
}

export function isLiveAttempt(
  row: LiveAttemptRow,
  clock: LiveAttemptClock,
): boolean {
  if (row.executionAttemptId === null) return false;
  if (row.executionDeadlineAt !== null) {
    const deadlineMs = new Date(row.executionDeadlineAt).getTime();
    if (Number.isFinite(deadlineMs) && deadlineMs <= clock.nowMs) return false;
  }
  if (UNCONDITIONALLY_LIVE.has(row.status)) return true;
  if (row.status === "pending_input") {
    return (
      row.humanWaitAttemptId !== null &&
      row.humanWaitAttemptId === row.executionAttemptId
    );
  }
  return false;
}

/**
 * The same predicate as a SQL condition fragment over an `agent_runs` alias —
 * the single source both guard adapters splice (callback guard and fixed-batch
 * guard SQL are GENERATED from here; codex-converged r1: no drift between the
 * two write worlds). Positional parameters are the caller's responsibility;
 * this returns text with the alias interpolated (a trusted identifier, never
 * user input).
 */
export function liveAttemptSqlCondition(alias: string): string {
  return (
    `(${alias}.execution_attempt_id IS NOT NULL` +
    ` AND (${alias}.execution_deadline_at IS NULL OR ${alias}.execution_deadline_at > now())` +
    ` AND (${alias}.status IN ('queued','running','pending_approval')` +
    ` OR (${alias}.status = 'pending_input'` +
    ` AND ${alias}.human_wait_attempt_id IS NOT NULL` +
    ` AND ${alias}.human_wait_attempt_id = ${alias}.execution_attempt_id)))`
  );
}
