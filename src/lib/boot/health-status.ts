// Health-status derivation (cinatra#789 item 1) — the pure mapping from a boot-state
// snapshot to the top-level health `status` + HTTP code the /api/health route returns.
//
// The KEY split: a `degraded` READINESS covers BOTH self-healing `retryable` failures
// and durable `degraded`-policy failures (boot-state folds both into readiness
// "degraded"). Only the DURABLE `degraded`-policy failures (snapshot.blockingPhases)
// are DEPLOY-BLOCKING; a `retryable` failure self-heals and must keep the instance
// health-passing (status "ok", HTTP 200) so a transient boot hiccup does not fail a
// deploy. See src/app/api/health/route.ts for the full contract.

import type { BootStateSnapshot } from "@/lib/boot/boot-state";

export type HealthStatus = "ok" | "degraded" | "starting" | "error";

export type DerivedHealth = {
  /** Top-level status a deploy gate polls. */
  status: HealthStatus;
  /** HTTP code to return (200 only for "ok"). */
  httpStatus: 200 | 503;
  /** True when any degraded/retryable phase failed (surfaced even when status stays "ok"). */
  degraded: boolean;
};

export function deriveHealthStatus(snapshot: BootStateSnapshot): DerivedHealth {
  const anyDegradation = snapshot.degradedPhases.length > 0;
  const deployBlocked = snapshot.blockingPhases.length > 0;

  switch (snapshot.readiness) {
    case "ready":
      // Fully ready. (readiness "ready" implies no degraded failure, but keep the
      // flag honest if a future path records one.)
      return { status: "ok", httpStatus: 200, degraded: anyDegradation };
    case "degraded":
      // Durable degraded failure -> deploy-blocking 503. Otherwise (only retryable
      // self-healing failures) stay "ok"/200 but surface degraded:true in the body.
      return deployBlocked
        ? { status: "degraded", httpStatus: 503, degraded: true }
        : { status: "ok", httpStatus: 200, degraded: true };
    case "booting":
      return { status: "starting", httpStatus: 503, degraded: anyDegradation };
    case "failed":
      return { status: "error", httpStatus: 503, degraded: anyDegradation };
    default:
      // Exhaustive; treat an unknown readiness as not-ready.
      return { status: "starting", httpStatus: 503, degraded: anyDegradation };
  }
}
