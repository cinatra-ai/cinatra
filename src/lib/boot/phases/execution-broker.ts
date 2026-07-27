// Execution-broker boot phase (exec-plane S1b activation, cinatra#2138
// deliverable 1; epic #1705).
//
// #1706 merged the executor core, the broker, the local-dev worker and the
// egress gateway, and deliberately left `registerExecutionExecutorFactory` with
// ZERO callers — so production `ready` was unreachable and the plane was inert.
// This phase is that caller, strictly behind the epic's default-off ROLLOUT
// flag.
//
// BYTE-EQUIVALENT INERTNESS (the pinned test): when
// `CINATRA_EXECUTION_PLANE_ROLLOUT` is not exactly `"on"`, this factory returns
// an EMPTY phase list. Not a phase that skips — no phase at all. The boot
// orchestrator's phase sequence, the boot-state snapshot and `/api/health` are
// therefore identical to today's, nothing registers an executor factory, and
// every environment's readiness stays in the store's existing not-ready state
// (`disabled` on an instance that never opted into the plane; `unavailable` on
// one that did — because no executor factory exists to make it `ready`).
//
// With the flag ON the phase reads the persisted placement mode:
//   - `disabled`  → nothing wired; status `inert`.
//   - `remote`    → NOT operable in this slice (the remote service boundary is
//     the S4 CLI slice); nothing wired; status `unavailable` with that reason.
//     The vocabulary persists, the placement does not activate — no pretending.
//   - `local-dev` → construct broker + worker (+ the attributing egress
//     gateway), run the broker↔worker health handshake, and ONLY on a completed
//     handshake register the executor factory (AC3).
//
// Never fatal: a wiring failure leaves the plane exactly as inert as it is
// today (fail-closed), it never blocks a boot — except on an instance CLASS
// that declares the plane REQUIRED, where the deficit is deploy-visible, the
// same policy `execution-plane-health` already applies.
//
// Deliberately NOT importing "server-only": vitest unit tests import the phase
// list. The heavy construction hides behind a lazy dynamic import.

import { isExecutionPlaneRolloutEnabled } from "@cinatra-ai/llm/execution-plane";

import type { BootPhase, BootPhaseOutcome } from "@/lib/boot/boot-phase";
import { executionPlaneRequired } from "@/lib/boot/phases/execution-plane-health";

/** The stable phase name surfaced to /api/health + operators. */
export const EXECUTION_BROKER_PHASE = "execution-broker";

export function executionBrokerPhases(
  env: Record<string, string | undefined> = process.env,
): BootPhase[] {
  // The default-off ROLLOUT gate. Off ⇒ NO PHASE AT ALL (see the header note on
  // byte-equivalent inertness). This is the whole activation switch.
  if (!isExecutionPlaneRolloutEnabled(env.CINATRA_EXECUTION_PLANE_ROLLOUT)) {
    return [];
  }

  const required = executionPlaneRequired(env);
  return [
    {
      name: EXECUTION_BROKER_PHASE,
      policy: required ? "degraded" : "retryable",
      run: async (): Promise<BootPhaseOutcome> => {
        const { readExecutionPlaneSettings } = await import(
          "@/lib/execution/execution-plane-settings"
        );
        const { registerExecutionBrokerStatus } = await import(
          "@/lib/execution/execution-broker-slot"
        );
        const {
          clearExecutionExecutorFactory,
          registerExecutionExecutorFactory,
        } = await import("@/lib/execution/execution-executor-slot");
        const settings = readExecutionPlaneSettings();

        if (settings.mode === "disabled") {
          // An earlier boot in this process may have registered a factory; a
          // `disabled` re-boot must not leave it reachable (Codex finding 4).
          clearExecutionExecutorFactory();
          registerExecutionBrokerStatus({
            rolloutEnabled: true,
            mode: settings.mode,
            state: "inert",
            detail:
              "Execution mode is set to Disabled — no broker, no worker, no sandbox capability.",
            egressMode: settings.egressMode,
          });
          return { skipped: "execution mode is disabled — nothing wired" };
        }

        if (settings.mode === "remote") {
          const detail =
            "Remote placement is part of the persisted vocabulary but is not operable on this " +
            "instance yet (the remote broker service boundary ships with the CLI slice). " +
            "Nothing is wired; the plane stays fail-closed.";
          clearExecutionExecutorFactory();
          registerExecutionBrokerStatus({
            rolloutEnabled: true,
            mode: settings.mode,
            state: "unavailable",
            detail,
            egressMode: settings.egressMode,
          });
          if (required) {
            throw new Error(`[${EXECUTION_BROKER_PHASE}] ${detail}`);
          }
          return { skipped: detail };
        }

        // local-dev: construct + handshake.
        const { constructLocalDevExecutionBroker } = await import(
          "@/lib/execution/execution-broker-construct"
        );

        const constructed = await constructLocalDevExecutionBroker({ settings, env });
        if (!constructed.ok) {
          // NOTHING registers. `resolveExecutionEnvironmentReadiness()` keeps
          // reporting a not-ready state and every declared-environment run keeps
          // refusing — the merged fail-closed posture, untouched.
          clearExecutionExecutorFactory();
          registerExecutionBrokerStatus({
            rolloutEnabled: true,
            mode: settings.mode,
            state: "unavailable",
            detail: constructed.reason,
            egressMode: settings.egressMode,
          });
          if (required) {
            throw new Error(
              `[${EXECUTION_BROKER_PHASE}] execution plane REQUIRED but the local-dev broker could ` +
                `not be wired (${constructed.reason}) — deploy-blocking for this instance class.`,
            );
          }
          return {
            skipped: `local-dev broker not wired (${constructed.reason}) — the plane stays inert`,
          };
        }

        const { executor, handshake, gateway, probeLiveness } = constructed.value;
        // AC3: the factory is registered ONLY past a completed handshake, so
        // `ready` is reachable only for a plane that has actually run a command
        // on a live worker. One memoized executor instance (its carrier→job map
        // is the L2 workspace-persistence contract), shared by every surface.
        registerExecutionExecutorFactory(() => executor);
        registerExecutionBrokerStatus({
          rolloutEnabled: true,
          mode: settings.mode,
          state: "running",
          handshake,
          ...(gateway ? { gateway } : {}),
          egressMode: settings.egressMode,
          probeLiveness,
        });
        console.log(
          `[${EXECUTION_BROKER_PHASE}] local-dev broker wired — handshake completed in ` +
            `${handshake.wallMs} ms over image ${handshake.imageDigest}` +
            (gateway ? ` (egress via ${gateway.containerName}:${gateway.proxyPort})` : ""),
        );
        return;
      },
    },
  ];
}
