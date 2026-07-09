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
