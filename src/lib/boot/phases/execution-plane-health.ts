// Execution-plane health boot phase (ops#517 / epic cinatra#1705 — the "health-view
// boot phase" listed as still-pending app wiring in
// packages/execution-plane/src/index.ts).
//
// Surfaces the app's EXECUTION-PLANE CLIENT readiness in the process boot-state
// snapshot so it reaches /api/health (src/app/api/health/route.ts) per INSTANCE-
// CLASS semantics:
//   - a class that REQUIRES the plane (EXECUTION_PLANE_REQUIRED=1) → `degraded`
//     policy: a not-configured / misconfigured plane is DEPLOY-BLOCKING (the phase
//     lands in snapshot.blockingPhases → health top-level status "degraded", HTTP
//     503 → the deploy gate rejects the boot).
//   - any other class → `retryable` policy: the deficit is surfaced (health
//     degradedPhases + degraded:true) but NON-blocking (HTTP 200) — matching the
//     epic's "internet-on / pass-through default; degraded otherwise".
//
// READINESS here is CONFIGURATION readiness — the client inputs the app needs to
// reach the broker: EXECUTION_BROKER_URL (a valid http(s) URL) and the client
// credential EXECUTION_BROKER_SECRET (packages/llm/src/execution-plane/session.ts
// fail-closes without it). A LIVE broker reachability probe is a later S1 slice (the
// HTTP/mTLS service boundary is still outside the execution-plane package); this
// phase is INERT (skipped) on an instance that has not opted into the plane, so
// today's instances are unaffected.
//
// Deliberately NOT importing "server-only": vitest unit tests import the phase list.

import type { BootPhase, BootPhaseOutcome } from "@/lib/boot/boot-phase";

/** The stable phase name surfaced to /api/health + operators. */
export const EXECUTION_PLANE_HEALTH_PHASE = "execution-plane-health";

/** True when this instance CLASS requires the execution plane (deploy-blocking). */
export function executionPlaneRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.EXECUTION_PLANE_REQUIRED === "1";
}

export type ExecutionPlaneReadiness =
  | { state: "not-configured" }
  | { state: "ready" }
  | { state: "misconfigured"; reason: string };

/** Pure evaluation of the exec-plane CLIENT configuration (no I/O). */
export function evaluateExecutionPlaneReadiness(
  env: Record<string, string | undefined> = process.env,
): ExecutionPlaneReadiness {
  const url = (env.EXECUTION_BROKER_URL ?? "").trim();
  const secret = (env.EXECUTION_BROKER_SECRET ?? "").trim();
  if (url === "" && secret === "") return { state: "not-configured" };
  const missing: string[] = [];
  if (url === "") missing.push("EXECUTION_BROKER_URL");
  if (secret === "") missing.push("EXECUTION_BROKER_SECRET");
  if (missing.length > 0) {
    return { state: "misconfigured", reason: `missing ${missing.join(", ")}` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "misconfigured", reason: "EXECUTION_BROKER_URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      state: "misconfigured",
      reason: `EXECUTION_BROKER_URL must be http(s) (got ${parsed.protocol})`,
    };
  }
  return { state: "ready" };
}

/**
 * The execution-plane health phase. Policy is chosen by instance class:
 *   required class → `degraded`  (a failure is DEPLOY-BLOCKING)
 *   otherwise      → `retryable` (a failure is non-blocking degraded)
 * Body:
 *   not-configured & not required → skipped (inert; today's instances)
 *   not-configured & required     → throw  (the class needs the plane → blocked)
 *   misconfigured                 → throw  (blocked if required, else degraded)
 *   ready                         → ok
 */
export function executionPlaneHealthPhases(
  env: Record<string, string | undefined> = process.env,
): BootPhase[] {
  const required = executionPlaneRequired(env);
  return [
    {
      name: EXECUTION_PLANE_HEALTH_PHASE,
      policy: required ? "degraded" : "retryable",
      run: (): BootPhaseOutcome => {
        const readiness = evaluateExecutionPlaneReadiness(env);
        switch (readiness.state) {
          case "ready":
            return;
          case "not-configured":
            if (required) {
              throw new Error(
                `[${EXECUTION_PLANE_HEALTH_PHASE}] EXECUTION_PLANE_REQUIRED=1 but the execution-plane ` +
                  "client is not configured (EXECUTION_BROKER_URL + EXECUTION_BROKER_SECRET) — " +
                  "deploy-blocking for this instance class.",
              );
            }
            return {
              skipped: "execution plane not configured and not required for this instance class",
            };
          case "misconfigured":
            throw new Error(
              `[${EXECUTION_PLANE_HEALTH_PHASE}] execution-plane client misconfigured: ${readiness.reason}` +
                (required ? " — deploy-blocking for this instance class." : ""),
            );
        }
      },
    },
  ];
}
