import "server-only";

// Gated perf instrumentation for the /notifications cold-vs-warm RCA.
// Zero BEHAVIOR change when
// CINATRA_PERF_NOTIFICATIONS !== "1". Cost when disabled is negligible but
// NOT literally zero: the gated
// log fns early-return on an env compare, but notifPerfNow() always reads
// process.hrtime.bigint() at the instrumented boundaries and the auth
// call-counter increments unconditionally. That counter is process-global
// (not request-scoped), so it is aggregate evidence — correlate with
// surrounding [notif-perf] lines.
//
// Enable with `CINATRA_PERF_NOTIFICATIONS=1 pnpm dev` to attribute the
// first-hit cost across page → auth → schema-ensure → query boundaries.
//
// Kept in the shipped tree (like scripts/bench-cold-start.mjs) so future
// cold-start attribution is reproducible without re-instrumenting. Lives
// inside @cinatra-ai/notifications so the host-side boundaries (page,
// auth-session) and the package-side boundaries (service) share one helper.

import { threadId } from "node:worker_threads";

export function notifPerfEnabled(): boolean {
  return process.env.CINATRA_PERF_NOTIFICATIONS === "1";
}

/** Log a labelled duration (ms). No-op unless the env flag is set. */
export function notifPerf(label: string, startNs: bigint): void {
  if (!notifPerfEnabled()) return;
  const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
  console.log(
    `[notif-perf] pid=${process.pid} tid=${threadId} ${label}=${ms.toFixed(1)}ms`,
  );
}

/** Log a discrete fact (branch taken, count, etc.). No-op unless enabled. */
export function notifPerfNote(label: string, value: string | number): void {
  if (!notifPerfEnabled()) return;
  console.log(
    `[notif-perf] pid=${process.pid} tid=${threadId} ${label}=${value}`,
  );
}

/** Convenience: current hrtime nanoseconds. */
export function notifPerfNow(): bigint {
  return process.hrtime.bigint();
}
