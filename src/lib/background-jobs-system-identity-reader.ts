import type { ActorContext } from "@/lib/authz/actor-context";
import type { JobAuthorityMetadata } from "@/lib/background-jobs-registry";

/**
 * Read-only slot access to the boot-registered job-system runtime
 * (`src/lib/background-jobs-system-frame.ts`, cinatra#1941 S2). Extracted
 * from `background-jobs.ts` into this leaf module to keep that file under
 * its file-size ratchet ceiling — the exact same extraction pattern already
 * used for `background-jobs-notify.ts` (cinatra#2039 S1 ratchet slice).
 *
 * `background-jobs.ts` (and `background-jobs-registry.ts`) sit in the
 * reachable first-party graph of the LOCKED dev-perf routes (the route-graph
 * ratchet counts even a dynamic `import()` specifier), so the frame module
 * itself is NEVER imported here — not statically, not dynamically, not even
 * type-only. Instead this module declares its OWN structural type for the
 * slot's shape and reads `globalThis.__cinatraJobSystemRuntime` through a
 * local cast, mirroring the shape `background-jobs-system-frame.ts`
 * registers. The two modules are pinned together only by a behavioral
 * contract test (`background-jobs-system-frame.test.ts` +
 * `system-loops-job-system-runtime-boot-seed.test.ts`), never by an import
 * edge.
 */
export type JobSystemRuntimeSlot = {
  runWithJobFrame: <T>(
    frame: { jobName: string; jobId: string; authority: JobAuthorityMetadata; payload: unknown },
    fn: () => T | Promise<T>,
  ) => T | Promise<T>;
  buildSystemIdentity: (jobName: string, jobId: string) => ActorContext;
  auditUnclassifiedRefusal: (jobName: string, jobId: string) => void;
  auditFrameAnomaly: (jobName: string, jobId: string, principalType: string) => void;
};

export function resolveJobSystemRuntime(): JobSystemRuntimeSlot | undefined {
  return (globalThis as unknown as { __cinatraJobSystemRuntime?: JobSystemRuntimeSlot })
    .__cinatraJobSystemRuntime;
}

const JOB_SYSTEM_SLOT_EMPTY_WARN_INTERVAL_MS = 60_000;
let lastJobSystemSlotEmptyWarnAt = 0;

/**
 * Rate-limited visibility for a `system-maintenance` job dispatching before
 * `system-loops`'s boot phase has registered the runtime (design doc §3.2
 * "slot-empty policy"). A hard dispatch refusal here was REBUTTED for day-1:
 * it would recreate the cinatra#849 recurring-loop-death pathology (a throw
 * before `runRecurringLoop`'s re-delay marks an `attempts:1` job permanently
 * failed), and pre-wave-3 maintenance writers don't consult the frame at
 * all, so refusing dispatch would add zero write protection. This
 * warn+Sentry capture is visibility only; the durable fail-closed point is
 * the mint seam (`job-system-authority-mint.ts`), which refuses every mint
 * with no active frame.
 */
export function warnJobSystemSlotEmpty(jobName: string, jobId: string, queueName: string): void {
  const now = Date.now();
  if (now - lastJobSystemSlotEmptyWarnAt < JOB_SYSTEM_SLOT_EMPTY_WARN_INTERVAL_MS) return;
  lastJobSystemSlotEmptyWarnAt = now;
  console.warn(
    `[background-jobs] system-maintenance job "${jobName}" dispatched with the job-system runtime slot EMPTY — no audited System frame this cycle (cinatra#1941; expected only before boot's system-loops phase registers it).`,
  );
  void import("@cinatra-ai/errors/server")
    .then(({ captureBackgroundJobError }) =>
      captureBackgroundJobError(new Error(`job-system runtime slot empty for "${jobName}"`), {
        jobName,
        jobId,
        queueName,
      }),
    )
    .catch(() => {
      // Sentry helper unavailable — never break the worker.
    });
}
