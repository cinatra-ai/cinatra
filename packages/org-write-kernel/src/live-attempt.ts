/**
 * The ONE live-attempt predicate — cinatra#1938 (archive epic S2).
 *
 * Both consumers evaluate exactly this function, so they can never diverge:
 *   - archive-lease snapshot eligibility ("which in-flight runs get a bounded
 *     window when the org archives");
 *   - run-authority minting (`verifyRunAuthority` refuses a VerifiedRunRef for
 *     anything that fails it).
 *
 * Grounded against the REAL transition table (run-status.ts), which corrected
 * the original design's framing:
 *   - `pending_input` is categorically PARKED: every edge into it is
 *     pre-dispatch (setup, compensation, resets — `failed→pending_input`
 *     retains a stale attempt id) INCLUDING the one "genuine human wait"
 *     (#1058), which fires from `queued` BEFORE the dispatch CAS. Never live.
 *   - `queued` is pre-dispatch by definition (the attempt id on a queued row
 *     is from a PREVIOUS dispatch); the S3 dispatch freeze governs it under
 *     archive. Never live.
 *   - `waiting_trigger` is unambiguously MID-ATTEMPT (only reachable from
 *     `running`; holds an open a2aContextId). Live.
 *   - `pending_approval` is the ONE ambiguous state: entered mid-attempt
 *     (`running→`, interrupt paths) AND pre-dispatch (`queued→`, setup
 *     interrupts). The durable discriminator is `human_wait_attempt_id`,
 *     stamped BY THE EDGE inside the status CAS (running→pending_approval
 *     copies the row's own attempt id; queued→pending_approval and every
 *     dispatch clear it). Live only while it equals the current attempt id.
 */

/** Mid-attempt beyond doubt: executing, or a WayFlow trigger wait holding an
 *  open context. Pre-dispatch (queued, pending_input, pending_trigger, armed)
 *  and terminal states are NOT here. */
const UNCONDITIONALLY_LIVE = new Set(["running", "waiting_trigger"]);

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
  // A NULL deadline is FAIL-CLOSED: every dispatch stamps
  // one (COALESCE(timeout, 86400) — S1), so NULL means a legacy/corrupt row,
  // and an unbounded row cannot hold a "bounded verifiable window" anyway
  // (a lease copies this deadline and NULL could never satisfy
  // expires_at > now() semantics honestly).
  if (row.executionDeadlineAt === null) return false;
  const deadlineMs = new Date(row.executionDeadlineAt).getTime();
  if (!Number.isFinite(deadlineMs) || deadlineMs <= clock.nowMs) return false;
  if (UNCONDITIONALLY_LIVE.has(row.status)) return true;
  if (row.status === "pending_approval") {
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
 * guard SQL are GENERATED from here; design review: no drift between the
 * two write worlds). Positional parameters are the caller's responsibility;
 * this returns text with the alias interpolated (a trusted identifier, never
 * user input).
 */
export function liveAttemptSqlCondition(alias: string): string {
  return (
    `(${alias}.execution_attempt_id IS NOT NULL` +
    ` AND ${alias}.execution_deadline_at IS NOT NULL AND ${alias}.execution_deadline_at > now()` +
    ` AND (${alias}.status IN ('running','waiting_trigger')` +
    ` OR (${alias}.status = 'pending_approval'` +
    ` AND ${alias}.human_wait_attempt_id IS NOT NULL` +
    ` AND ${alias}.human_wait_attempt_id = ${alias}.execution_attempt_id)))`
  );
}
