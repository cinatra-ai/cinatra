// Agent published-marker self-heal boot phase (engineering #418).
//
// WayFlow's agent loader hard-gates each agent on a valid `.cinatra-published.json`
// marker whose `oasSha256` must match the agent's `cinatra/oas.json`. A fresh
// install / re-install / OAS edit can leave an agent dir with a missing or stale
// marker, so the loader silently refuses to mount it (the ossflywheel deploy hit
// this: 6 `oas.json` but 1 marker → 5 agents would not load; markers were
// backfilled by hand).
//
// The host-side `backfillPublishedMarkers` helper already self-heals every agent
// dir (missing → written, stale/malformed → rewritten, in-progress-draft skipped,
// atomic + idempotent). It used to run ONLY inside the dev-only agents/skills scan,
// so PROD installs never self-healed. This phase promotes that backfill into a
// PROD-SAFE, always-on (dev AND prod) boot phase so every install/re-install
// self-heals at startup.
//
// Why `degraded`: a backfill failure must never abort boot — the process serves,
// and any agent whose marker could not be repaired simply stays gated (the same
// pre-#418 behavior) until the next boot or publish retries. The label records that
// the deficit (some agents possibly unmounted) is durable for this process lifetime.
//
// Prod-safety (all already guaranteed by the helper):
//   - idempotent: valid + matching marker ⇒ `skipped` (no write, no churn);
//   - never clobbers a valid marker;
//   - in-progress-draft guard: a slug carrying `.cinatra-in-progress.json` is
//     skipped entirely, so a mid-draft chat-authoring agent is never promoted;
//   - atomic write (tmp + rename), safe under a concurrent/duplicate boot — the
//     worst case is two boots writing the SAME bytes to the marker;
//   - lightweight: it stats `oas.json` + reads the marker per slug; it does NOT do
//     the ~18s dev filesystem agent-ingest (that stays in the dev-only scan).
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function agentMarkerBackfillPhases(): BootPhase[] {
  return [
    {
      name: "agent-marker-backfill",
      policy: "degraded",
      run: async () => {
        const { backfillPublishedMarkers, triggerWayflowReload } = await import(
          "@cinatra-ai/agents"
        );
        const { resolveAgentRuntimeMountDir, resolveDevExtensionSourceRoot } =
          await import("@cinatra-ai/agents/agent-runtime-mount");

        // Backfill `.cinatra-published.json` markers for every on-disk agent dir
        // BEFORE wayflow's loader scans. Idempotent; missing/stale markers are
        // (re)derived from the current oas.json hash; in-progress drafts skipped.
        //
        // TWO trees, because dev and prod mount DIFFERENT dirs into wayflow:
        //   1. the RUNTIME mount (`<extension-data-root>/.agent-mount`) — the
        //      deploy-owned projection prod wayflow mounts;
        //   2. dev only: the git-native dev source tree (`<cwd>/extensions`) —
        //      the dir docker-compose.yml bind-mounts (`./extensions:/agents:ro`)
        //      into the dev wayflow container. When this phase was promoted out
        //      of the dev-only scan it kept ONLY tree (1), so a FRESH dev
        //      environment (pinned clones ship no markers; the wayflow loader
        //      cannot write through its ro mount) served ZERO agents: the
        //      widget-stream relay 404'd on the agent card and the wp/drupal
        //      UAT SSE/edit scenarios failed with "(no response)" on every
        //      fresh run (cinatra#1137) while long-lived checkouts kept
        //      coasting on markers written before the promotion.
        const trees: Array<{ dir: string; label: string }> = [
          { dir: resolveAgentRuntimeMountDir(), label: "runtime-mount" },
        ];
        if (
          process.env.CINATRA_RUNTIME_MODE === "development" &&
          process.env.NODE_ENV !== "production"
        ) {
          trees.push({ dir: resolveDevExtensionSourceRoot(), label: "dev-source" });
        }

        let repaired = 0;
        let writtenTotal = 0;
        let rewrittenTotal = 0;
        for (const tree of trees) {
          const result = await backfillPublishedMarkers(tree.dir);
          repaired += result.written + result.rewritten;
          writtenTotal += result.written;
          rewrittenTotal += result.rewritten;
          if (result.written + result.rewritten > 0 || result.errors.length > 0) {
            console.log(
              `[agents/backfill-markers] tree=${tree.label} scanned=${result.scanned} ` +
                `written=${result.written} rewritten=${result.rewritten} ` +
                `skipped=${result.skipped} errors=${result.errors.length}`,
            );
            for (const err of result.errors) {
              console.warn(`[agents/backfill-markers] ${err.path}: ${err.reason}`);
            }
          }
        }

        // If backfill (re)wrote any markers, wake the wayflow container — it may
        // have scanned a markerless/stale tree at its own startup. Failure is
        // non-fatal: a later publish/preflight reload retries.
        if (repaired > 0) {
          try {
            const reloadResult = await triggerWayflowReload();
            if (reloadResult.ok) {
              console.log(
                `[agents/backfill-markers] post-backfill reload triggered (` +
                  `wrote ${writtenTotal} + rewrote ${rewrittenTotal} markers; ` +
                  `wayflow mounted ${reloadResult.report.agents ?? "?"} agents)`,
              );
            } else {
              console.warn(
                `[agents/backfill-markers] post-backfill reload returned ok:false ` +
                  `reason=${reloadResult.reason} detail=${reloadResult.detail ?? "—"} ` +
                  `(wayflow may still be starting; next publish/preflight will retry)`,
              );
            }
          } catch (reloadErr) {
            console.warn(
              "[agents/backfill-markers] post-backfill reload threw (non-fatal):",
              reloadErr,
            );
          }
        }
      },
    },
  ];
}
