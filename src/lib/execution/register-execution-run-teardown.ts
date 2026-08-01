import "server-only";

// DI slot for the execution plane's RUN-teardown participant (epic #1705 AC9).
//
// AC9 requires hard removal (force_delete / purge) to cancel the package's
// queued sandbox work and put its retained run workspaces on immediate GC. The
// broker has carried that capability since S1 (`terminateJobsForRun`) and had
// NO production caller: nothing connected a lifecycle event to it. This slot is
// the seam that connects them.
//
// Why a slot at all — the same reason `register-execution-environment-service`
// is one: `src/lib/extension-data-teardown-wiring.ts` is loaded on EVERY path
// that can hard-remove an extension, including UI Server Actions, and must not
// pull the heavy `@cinatra-ai/execution-plane` graph at module load. The boot
// phase that already constructs the broker registers the participant here; the
// wiring reads this lightweight, `globalThis`-anchored module only.
//
// FAIL-QUIET DEFAULT: unregistered ⇒ `undefined` ⇒ the teardown half is a
// no-op. That is correct rather than fail-closed, deliberately: an instance
// with no execution plane has no jobs to cancel and no workspaces to collect,
// and a hard removal that is ALREADY COMMITTED must never be aborted by a
// missing best-effort participant.

/**
 * Cancel every queued/open sandbox job bound to these runs and collect their
 * retained L2 workspaces. Best-effort and idempotent; resolves a small summary
 * that is logged, never depended on.
 */
export type ExecutionRunTeardownParticipant = (input: {
  packageName: string;
  runIds: readonly string[];
  /** True when the caller's id list was capped (there were MORE runs). */
  runIdsTruncated?: boolean;
}) => Promise<{ runs: number; terminatedJobs: number }>;

declare global {
  var __cinatraExecutionRunTeardown: ExecutionRunTeardownParticipant | undefined;
}

/** Install the participant (boot phase). Last write wins (idempotent re-boot). */
export function registerExecutionRunTeardown(
  participant: ExecutionRunTeardownParticipant,
): void {
  globalThis.__cinatraExecutionRunTeardown = participant;
}

/** Drop the participant — a re-boot that wires no broker must not leave a stale
 *  one reachable (it would hold a closed client). */
export function clearExecutionRunTeardown(): void {
  globalThis.__cinatraExecutionRunTeardown = undefined;
}

export function getExecutionRunTeardownParticipant():
  | ExecutionRunTeardownParticipant
  | undefined {
  return globalThis.__cinatraExecutionRunTeardown;
}
