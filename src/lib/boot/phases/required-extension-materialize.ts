// Required-extension OAS materialization boot phase (cinatra-ai/ops#436).
//
// Reconciles the image-baked required-extension OAS seed into the live
// agent-install dir BEFORE the agent published-marker backfill scans it and
// BEFORE WayFlow's loader needs a fresh tree. This is the cinatra-image half of
// making the required-extension set materializable on deploy (the ops half
// points `CINATRA_AGENT_INSTALL_DIR` + the WayFlow `:/agents:ro` mount at a
// deploy-refreshable dir instead of the frozen named volume over /app/extensions).
//
// Policy:
//   - PROD: `fatal` + fail-closed — a missing/unreadable/corrupt seed aborts
//     boot. The required-activation assert checks the in-process registry, not
//     the filesystem, so without this gate a prod boot could come up "healthy"
//     while WayFlow points at an empty/stale tree. Failing closed surfaces a
//     broken image at deploy time.
//   - DEV: the phase still runs but is NOT fail-closed (a minimal dev checkout
//     has no baked seed — the dev git-native scan owns the tree there), and a
//     failure is swallowed. The dev/prod split lives inside the phase body so
//     the phase only throws in production.
//
// Ordering (set by the orchestrator): AFTER core boot (DI/migrations/identity)
// and BEFORE `agent-marker-backfill` (which then self-heals any remaining marker
// gaps idempotently) and before readiness.
//
// WayFlow-reload safety: a freshly materialized agent dir is MARKERLESS, and
// WayFlow's loader hard-gates each agent on a valid `.cinatra-published.json`
// marker. So this phase MUST backfill markers for the reconciled tree BEFORE it
// asks WayFlow to reload — otherwise an early reload would mount ZERO of the new
// required agents. It therefore writes markers itself (the same idempotent
// `backfillPublishedMarkers` the engineering #418 phase uses) and only then
// reloads — and only when the on-disk tree actually changed (materialized OR
// pruned; a prune must drop the agent from WayFlow's mounted set, and no marker
// write would otherwise trigger a reload). The downstream agent-marker-backfill
// phase stays as the always-on net (idempotent: valid markers ⇒ skipped).
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

function inProdMode(): boolean {
  return process.env.CINATRA_RUNTIME_MODE !== "development";
}

export function requiredExtensionMaterializePhases(): BootPhase[] {
  return [
    {
      name: "required-extension-materialize",
      // `fatal` so a prod failure aborts boot; the dev/prod split inside the
      // body means it only throws in production.
      policy: "fatal",
      run: async () => {
        if (process.env.CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE === "true") {
          return { skipped: "disabled via CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE" };
        }

        const prod = inProdMode();
        const { materializeRequiredExtensions } = await import(
          "@/lib/required-extension-materialize"
        );
        const { resolveAgentInstallDir } = await import(
          "@cinatra-ai/agents/agent-install-path"
        );
        const installDir = resolveAgentInstallDir();

        let result;
        try {
          result = materializeRequiredExtensions({ installDir, failClosed: prod });
        } catch (err) {
          if (prod) throw err; // fail-closed: abort the prod boot
          console.warn(
            "[required-extension-materialize] dev reconcile skipped (non-fatal):",
            err instanceof Error ? err.message : err,
          );
          return { skipped: "dev reconcile failed (non-fatal)" };
        }

        if (result.note && !result.changed) {
          // Benign no-op (e.g. dev with no baked seed).
          return { skipped: result.note };
        }

        if (result.materialized.length || result.pruned.length || result.unchanged.length) {
          console.info(
            `[required-extension-materialize] install dir ${installDir}: ` +
              `materialized=${result.materialized.length} ` +
              `unchanged=${result.unchanged.length} pruned=${result.pruned.length}` +
              (result.materialized.length ? ` [+ ${result.materialized.join(", ")}]` : "") +
              (result.pruned.length ? ` [- ${result.pruned.join(", ")}]` : ""),
          );
        }

        // Wake WayFlow only when the on-disk tree actually changed (materialized
        // or pruned). CRITICAL ORDER: backfill the published-markers for the
        // reconciled tree FIRST, then reload — a freshly materialized agent dir
        // is markerless, and WayFlow gates on a valid marker, so an early reload
        // would mount zero of the new required agents. Marker writes here are the
        // same idempotent helper the always-on agent-marker-backfill phase uses;
        // that phase still runs next as the net.
        if (result.changed) {
          try {
            const { backfillPublishedMarkers, triggerWayflowReload } = await import(
              "@cinatra-ai/agents"
            );
            // Backfill markers for the reconciled tree BEFORE reloading. If new
            // dirs were MATERIALIZED, a reload is only safe once their markers
            // exist (WayFlow gates on the marker) — so on a backfill failure we
            // SKIP the reload here and defer entirely to the downstream always-on
            // agent-marker-backfill phase (which writes markers then reloads).
            // A pure-PRUNE reconcile (no new dirs) needs no markers, so it still
            // reloads to drop the removed agent from WayFlow's mounted set.
            let markersReady = true;
            try {
              await backfillPublishedMarkers(installDir);
            } catch (markerErr) {
              markersReady = false;
              console.warn(
                "[required-extension-materialize] marker backfill before reload failed (non-fatal; " +
                  "the always-on agent-marker-backfill phase retries):",
                markerErr,
              );
            }
            if (result.materialized.length > 0 && !markersReady) {
              console.warn(
                "[required-extension-materialize] skipping reload — newly materialized dirs have no " +
                  "markers yet (agent-marker-backfill will write them and reload).",
              );
              return;
            }
            const reload = await triggerWayflowReload();
            if (reload.ok) {
              console.info(
                `[required-extension-materialize] post-reconcile reload triggered ` +
                  `(wayflow mounted ${reload.report.agents ?? "?"} agents)`,
              );
            } else {
              console.warn(
                `[required-extension-materialize] post-reconcile reload ok:false ` +
                  `reason=${reload.reason} (wayflow may still be starting; ` +
                  `agent-marker-backfill / next publish retries)`,
              );
            }
          } catch (reloadErr) {
            console.warn(
              "[required-extension-materialize] post-reconcile reload threw (non-fatal):",
              reloadErr,
            );
          }
        }
      },
    },
  ];
}
