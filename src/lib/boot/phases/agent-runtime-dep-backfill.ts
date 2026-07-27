// Agent runtime-dependency projection backfill boot phase (cinatra#1056).
//
// Re-projects each already-installed agent_template's canonical dependency edges
// (persisted on its `installed_extension` row) onto the two runtime-gate columns
// the run layer reads — `connector_dependencies` (run-enqueue connector
// preflight) and `agent_dependencies` (orchestrator-readiness gate). Templates
// installed before the install-time projection landed carry the edges only on
// the canonical row, so their runtime gates would stay inert without this pass.
//
// `retryable`: a backfill failure must never abort boot (the process serves; the
// pass retries next boot). Idempotent, kill-switchable, soft-failing per row —
// all guaranteed by the helper. MERGE-not-clear, so a legacy-only template keeps
// its install-seeded `agent_dependencies` untouched.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function agentRuntimeDepBackfillPhases(): BootPhase[] {
  return [
    {
      name: "agent-runtime-dep-backfill",
      policy: "retryable",
      run: async () => {
        if ((process.env.CINATRA_AGENT_RUNTIME_DEP_BACKFILL ?? "").trim().toLowerCase() === "off") {
          return { skipped: "disabled via CINATRA_AGENT_RUNTIME_DEP_BACKFILL=off" };
        }
        const { runAgentRuntimeDepProjectionBackfill } = await import(
          "@/lib/agent-runtime-dep-projection-backfill"
        );
        const r = await runAgentRuntimeDepProjectionBackfill({ log: (m) => console.info(m) });
        if (r.skippedReason) {
          return { skipped: r.skippedReason };
        }
        if (r.updated > 0 || r.failed > 0) {
          console.info(
            `[boot] AgentRuntimeDepBackfill: scanned ${r.scanned}, ` +
              `updated ${r.updated}, unchanged ${r.unchanged}, failed ${r.failed}`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Core lifecycle-declaration projection boot phase (cinatra#2047 defect D-1).
// ---------------------------------------------------------------------------
//
// Co-located with the runtime-dependency backfill above: same shape (re-project
// a canonical declaration onto the agent_templates columns the runtime reads),
// same policy, and co-locating keeps the locked dev-perf route graphs from
// gaining a module for a boot-only phase.
//
// Re-projects the CORE-owned agent lifecycle declarations
// (the core repair-producer registry — today: the blog pipeline, epic #2037
// S2's first repairing producer) onto the matching installed templates'
// `agent_templates.lifecycle_config` column.
//
// Why this exists: the `changes_requested` route keys on
// `lifecycle_config.repairCapable`. An extension declares that in its own
// manifest (compiled at install by the seed builder); a producer
// whose repair implementation lives in CORE cannot, so core declares it here and
// this phase lands it on the row. Without it every `changes_requested` fell
// through to `human_escalation` — the S8 acceptance defect D-1.
//
// A core-owned declaration also changes when CORE ships, not when the extension
// re-publishes, so a boot-time re-projection (not only an install-time write) is
// the correct shape. Same posture as the agent runtime-dependency projection
// backfill: idempotent, MERGE-not-clear, soft-failing per row, kill-switchable
// (`CINATRA_LIFECYCLE_CONFIG_PROJECTION=off`), `retryable` so a failure never
// aborts boot.
//
export function lifecycleConfigProjectionPhases(): BootPhase[] {
  return [
    {
      name: "lifecycle-config-projection",
      policy: "retryable",
      run: async () => {
        const { projectCoreLifecycleConfig, LIFECYCLE_CONFIG_PROJECTION_ENV } = await import(
          "@cinatra-ai/agents/lifecycle-config-projection"
        );
        const summary = await projectCoreLifecycleConfig({ log: (m) => console.info(m) });
        if (summary.skippedReason) {
          return { skipped: summary.skippedReason };
        }
        if (summary.updated > 0 || summary.failed > 0) {
          console.info(
            `[boot] LifecycleConfigProjection: scanned ${summary.scanned}, ` +
              `updated ${summary.updated}, unchanged ${summary.unchanged}, ` +
              `failed ${summary.failed} (kill switch: ${LIFECYCLE_CONFIG_PROJECTION_ENV}=off)`,
          );
        }
      },
    },
  ];
}
