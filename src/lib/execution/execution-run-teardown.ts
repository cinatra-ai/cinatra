import "server-only";

// The hard-removal RUN teardown participant (epic #1705 AC9).
//
// AC9's two unimplemented duties, in its own words: hard removal "cancels
// queued jobs" and "GCs retained workspaces". Both are broker operations, and
// both are reached through the ONE seam the broker already exposes for exactly
// this — `terminateJobsForRun(runId, { removeWorkspace: true })`, which is on
// the local broker, the wire protocol and the remote client alike, so this
// module works identically in both placements and knows about neither.
//
// WHY THE RUN IDS ARRIVE FROM OUTSIDE. The destructive lifecycle step deletes
// `agent_runs` BEFORE it fires the data-teardown hook (force_delete pre-cleans
// the RESTRICT FK sources; the purge saga's atomic delete does the same), so a
// participant that tried to resolve packageName → runIds here would find
// nothing. The ids are therefore captured inside the deleting transaction and
// handed over — see `ExtensionDataTeardownContext`.
//
// BEST-EFFORT AND PER-RUN ISOLATED. The removal it follows is already
// committed; a broker that is down, a run whose teardown throws, must not
// abort the rest. Everything the plane misses here is still bounded by its own
// backstops: a job of a deleted run fails its next command closed on the
// liveness probe, and the retention GC eventually reaps the volume. This
// participant is what makes those outcomes IMMEDIATE rather than eventual.

import type { ExecutionRunTeardownParticipant } from "@/lib/execution/register-execution-environment-service";

/** How many runs one teardown fire will drive. */
export const MAX_TEARDOWN_RUNS = 5_000;

export type ExecutionRunTeardownDeps = {
  /**
   * The broker seam. `ExecutionBroker.terminateJobsForRun` and
   * `BrokerServiceClient.terminateJobsForRun` both satisfy it — this module is
   * deliberately placement-agnostic.
   */
  terminateJobsForRun: (
    runId: string,
    opts?: { removeWorkspace?: boolean },
  ) => Promise<number>;
  /** Injectable for tests; defaults to `console.warn`. */
  warn?: (message: string, detail: unknown) => void;
  maxRuns?: number;
};

export function createExecutionRunTeardownParticipant(
  deps: ExecutionRunTeardownDeps,
): ExecutionRunTeardownParticipant {
  const warn =
    deps.warn ??
    ((message: string, detail: unknown) => {
      console.warn(message, detail);
    });
  const maxRuns = deps.maxRuns ?? MAX_TEARDOWN_RUNS;

  return async ({ packageName, runIds, runIdsTruncated }) => {
    // De-duplicate: a caller may legitimately repeat an id, and terminating the
    // same run twice would double-count the summary for no benefit.
    const unique = [...new Set(runIds)].slice(0, maxRuns);
    if (runIdsTruncated || unique.length < new Set(runIds).size) {
      // Loud on purpose. Past the cap the immediate cancellation/GC does not
      // cover every run, and an operator reading "teardown complete" must not
      // conclude that it did.
      warn(
        `[teardown] execution-plane run teardown for ${packageName} is CAPPED at ` +
          `${maxRuns} runs — the remainder falls back to the liveness fail-closed ` +
          `path and the retention GC (never left running, just not immediate):`,
        { runs: unique.length, truncated: true },
      );
    }

    let terminatedJobs = 0;
    for (const runId of unique) {
      try {
        // `removeWorkspace` is what turns this from "stop the work" into
        // "collect the workspace too" — the second half of the AC.
        terminatedJobs += await deps.terminateJobsForRun(runId, {
          removeWorkspace: true,
        });
      } catch (err) {
        // PER-RUN isolation: one unreachable run must not strand the others.
        warn(
          `[teardown] execution-plane teardown failed for one run of ${packageName} ` +
            `(idempotent; the liveness fail-closed path and retention GC still apply):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { runs: unique.length, terminatedJobs };
  };
}
