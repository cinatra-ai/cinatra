// Environment-execution-service boot phase (exec-plane S3 A2, cinatra#1708;
// epic #1705).
//
// Instantiates the A2 execution-environment singletons (durable layer store +
// cache + trusted builder + broker-executor) and registers the tri-state DI
// slot the run seam + the A3 GC/teardown reach through. Placed AFTER
// `execution-plane-health` (it reuses that same readiness signal) and AFTER core
// boot (the core migration ran → the durable tables exist), immediately before
// `markBootReady()`.
//
// TRI-STATE (Codex findings 2/3/6 — fail-closed, never a silent L0 downgrade):
//   - `disabled`    — the instance is not opted into the plane. The phase
//     records `{ skipped }`; the slot advertises `disabled`. Today's instances
//     are byte-unchanged (declared-env runs refuse; no-env runs run L0).
//   - `ready`       — opted in + provenance key + a broker-executor binding:
//     construct the singletons and register the ready slot.
//   - `unavailable` — opted in / required BUT cannot instantiate (no provenance
//     key, or no broker-executor wiring yet). The slot advertises `unavailable`
//     so declared-env runs FAIL CLOSED; a REQUIRED class surfaces it as
//     deploy-visible (`degraded` policy → throw).
//
// Never `fatal`.
//
// Deliberately NOT importing "server-only" at the phase-list layer: vitest unit
// tests import the phase list. The heavy singleton construction is behind a lazy
// dynamic import so importing the phase list stays cheap.

import type { BootPhase, BootPhaseOutcome } from "@/lib/boot/boot-phase";
import { executionPlaneRequired } from "@/lib/boot/phases/execution-plane-health";

/** The stable phase name surfaced to /api/health + operators. */
export const ENVIRONMENT_EXECUTION_SERVICE_PHASE = "environment-execution-service";

export function environmentExecutionServicePhases(
  env: Record<string, string | undefined> = process.env,
): BootPhase[] {
  const required = executionPlaneRequired(env);
  return [
    {
      name: ENVIRONMENT_EXECUTION_SERVICE_PHASE,
      policy: required ? "degraded" : "retryable",
      run: async (): Promise<BootPhaseOutcome> => {
        const { resolveExecutionEnvironmentReadiness } = await import(
          "@/lib/execution/environment-execution-service"
        );
        const { registerExecutionEnvironmentService } = await import(
          "@/lib/execution/register-execution-environment-service"
        );
        const readiness = resolveExecutionEnvironmentReadiness(env);

        switch (readiness.state) {
          case "disabled":
            registerExecutionEnvironmentService({ state: "disabled" });
            return {
              skipped:
                "execution plane not opted in — declared-env runs refuse, no-env runs run L0 (byte-unchanged)",
            };
          case "ready": {
            // Import the heavy construction ONLY in the ready branch (keeps the
            // disabled/unavailable paths free of the execution-plane graph).
            const { constructReadyExecutionEnvironmentSlot } = await import(
              "@/lib/execution/environment-execution-service-construct"
            );
            const slot = constructReadyExecutionEnvironmentSlot(readiness, env);
            registerExecutionEnvironmentService(slot);
            console.log(
              `[${ENVIRONMENT_EXECUTION_SERVICE_PHASE}] ready — durable layer store + cache + builder + executor wired`,
            );
            return;
          }
          case "unavailable": {
            // Advertise unavailable so declared-env runs fail closed (never a
            // silent L0). A REQUIRED class surfaces it as deploy-visible.
            registerExecutionEnvironmentService({ state: "unavailable" });
            if (required) {
              throw new Error(
                `[${ENVIRONMENT_EXECUTION_SERVICE_PHASE}] execution plane REQUIRED but the environment ` +
                  `service is unavailable (${readiness.reason}) — deploy-blocking for this instance class.`,
              );
            }
            return {
              skipped: `environment service unavailable (${readiness.reason}) — declared-env runs fail closed`,
            };
          }
        }
      },
    },
  ];
}
