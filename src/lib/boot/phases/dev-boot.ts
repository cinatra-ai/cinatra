// Development-only boot phases (engineering #302).
//
// The dev-mode startup work extracted verbatim from `instrumentation.node.ts`.
// CRITICAL: two of these blocks were intentionally DETACHED (fire-and-forget
// `void (async () => {...})()`) so `register()` returns immediately and the dev
// server starts serving ~18s sooner — that detachment is PRESERVED here by the
// orchestrator (it calls `startDetachedDevPhases()` without awaiting), not by the
// phase runner. The a2a-dev-peer block was AWAITED in the original and stays a
// `dev-only` runBootPhase below.
//
// All `dev-only`: prod never executes them (the orchestrator gates the whole
// group on development mode), and a failure is always logged + swallowed.
//
// Deliberately NOT importing "server-only": unit tests import the helpers.

import type { BootPhase } from "@/lib/boot/boot-phase";
import { runBootPhase } from "@/lib/boot/boot-phase";

/**
 * The dev a2a-peer auto-import phase (was AWAITED in the original boot). Returned
 * as a `BootPhase` so the orchestrator runs it through the normal runner.
 */
export function devAwaitedPhases(): BootPhase[] {
  return [
    {
      name: "a2a-dev-auto-connect",
      policy: "dev-only",
      run: async () => {
        // Dev-only A2A peer auto-import. Double-gated: the orchestrator's outer
        // guard uses CINATRA_RUNTIME_MODE; the hook itself also guards on NODE_ENV.
        const { ensureA2ADevPeerConnections } = await import("@/lib/a2a-dev-auto-connect");
        await ensureA2ADevPeerConnections();
      },
    },
  ];
}

/**
 * Start DETACHED dev BLOCK 1 (fire-and-forget): the dev agents/skills filesystem
 * scan + marker backfill + WayFlow reload + hot-reload watcher (~18s of dev-only
 * work). Returns immediately so `register()` is not blocked. The ORIGINAL boot
 * fired this block at the EARLY interleave point (right after install-op cleanup,
 * before the always-on system services); the orchestrator calls it there.
 *
 * Mirrors the original `void (async () => {...})()` block exactly: errors are
 * self-contained (each inner try/catch logs + swallows; the runner is the net).
 * NOT awaited by the orchestrator — that detachment is the whole point.
 */
export function startDetachedDevAgentsScanPhase(): void {
  void runBootPhase({
    name: "dev-agents-skills-scan",
    policy: "dev-only",
    run: async () => {
      await runDevAgentsAndSkillsScan();
    },
  });
}

/**
 * Start DETACHED dev BLOCK 2 (fire-and-forget): dev-auto-setup (local docker
 * Drupal + WordPress wiring) followed by the per-extension devFixtures seeder.
 * Detached so docker exec latency / wp-cli/drush hiccups never block boot. The
 * ORIGINAL boot fired this block LAST (the trailing statement of `register()`);
 * the orchestrator calls it at the very end, after the system loops.
 *
 * NOT awaited by the orchestrator — that detachment is the whole point.
 */
export function startDetachedDevAutoSetupPhase(): void {
  void runBootPhase({
    name: "dev-auto-setup",
    policy: "dev-only",
    run: async () => {
      await runDevAutoSetupAndFixtures();
    },
  });
}

// ── Block 1 body (verbatim from the original detached IIFE) ──────────────────
async function runDevAgentsAndSkillsScan(): Promise<void> {
  // Load git-native agent definitions from agents/ at startup. The version-skip
  // guard in ensureAgentPackageFromGitFile ensures DB writes are skipped when the
  // packageVersion matches — restarts are low-overhead.
  try {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const {
      ensureAgentPackageFromGitFile,
      backfillPublishedMarkers,
      triggerWayflowReload,
    } = await import("@cinatra-ai/agents");
    const { resolveAgentInstallDir } = await import("@cinatra-ai/agents/agent-install-path");
    const agentsDir = resolveAgentInstallDir();

    // Backfill `.cinatra-published.json` markers for every existing on-disk agent
    // dir BEFORE wayflow's loader scans. Idempotent; missing markers are derived
    // from the current oas.json hash and treated as published.
    try {
      const result = await backfillPublishedMarkers(agentsDir);
      const repaired = result.written + result.rewritten;
      if (repaired > 0 || result.errors.length > 0) {
        console.log(
          `[agents/backfill-markers] scanned=${result.scanned} ` +
            `written=${result.written} rewritten=${result.rewritten} ` +
            `skipped=${result.skipped} errors=${result.errors.length}`,
        );
        for (const err of result.errors) {
          console.warn(`[agents/backfill-markers] ${err.path}: ${err.reason}`);
        }
      }
      // If backfill wrote any markers, wake the wayflow container (it scanned a
      // markerless tree at startup). Failure is non-fatal — next publish retries.
      if (repaired > 0) {
        try {
          const reloadResult = await triggerWayflowReload();
          if (reloadResult.ok) {
            console.log(
              `[agents/backfill-markers] post-backfill reload triggered (` +
                `wrote ${result.written} + rewrote ${result.rewritten} markers; ` +
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
    } catch (err) {
      console.warn("[agents/backfill-markers] failed (non-fatal):", err);
    }

    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(agentsDir, entry.name);

      // Vendor-namespace probe first
      // (e.g., extensions/cinatra-ai/<slug>-agent/cinatra/oas.json).
      let foundInside = false;
      try {
        const subEntries = await readdir(entryPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const oasJson = join(entryPath, sub.name, "cinatra", "oas.json");
          const transitional = join(entryPath, sub.name, "cinatra", "agent.json");
          const target = existsSync(oasJson)
            ? oasJson
            : (existsSync(transitional) ? transitional : null);
          if (target) {
            try {
              await ensureAgentPackageFromGitFile({ agentJsonPath: target, licenseAcknowledged: true });
            } catch (fileErr) {
              console.warn(`[agent-builder] git agent load skipped (${entry.name}/${sub.name}):`, fileErr);
            }
            foundInside = true;
          }
        }
      } catch {
        // Non-fatal — skip unreadable subdirectories
      }
      if (foundInside) continue;

      // Fallback layout — entry/<cinatra/agent.json> or entry/agent.json.
      const cinatraAgentJson = join(entryPath, "cinatra", "agent.json");
      const firstLevelAgentJson = join(entryPath, "agent.json");
      if (existsSync(cinatraAgentJson)) {
        try {
          await ensureAgentPackageFromGitFile({ agentJsonPath: cinatraAgentJson, licenseAcknowledged: true });
        } catch (fileErr) {
          console.warn(`[agent-builder] git agent load skipped (${entry.name}/cinatra):`, fileErr);
        }
      } else if (existsSync(firstLevelAgentJson)) {
        try {
          await ensureAgentPackageFromGitFile({ agentJsonPath: firstLevelAgentJson, licenseAcknowledged: true });
        } catch (fileErr) {
          console.warn(`[agent-builder] git agent load skipped (${entry.name}):`, fileErr);
        }
      }
    }
  } catch (err) {
    // Non-fatal — agents/ directory may not exist in minimal deployments
    console.warn("[agent-builder] agents/ directory scan skipped:", err);
  }

  // Dev-mode: load SKILL-kind extension packages at boot (the agent scan above
  // only covers agent kind) AND start the recursive hot-reload watcher so live
  // edits/additions under extensions/ surface without a server restart.
  try {
    const { resolveAgentInstallDir } = await import("@cinatra-ai/agents/agent-install-path");
    const {
      loadAllSkillPackagesAtBoot,
      startDevExtensionsWatcher,
    } = await import("@/lib/extensions-dev-watcher");
    const extRoot = resolveAgentInstallDir();
    await loadAllSkillPackagesAtBoot(extRoot);
    startDevExtensionsWatcher(extRoot);
  } catch (err) {
    console.warn(
      "[dev-extensions] boot wiring skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Block 2 body (verbatim from the original detached IIFE) ──────────────────
async function runDevAutoSetupAndFixtures(): Promise<void> {
  try {
    const { runDevAutoSetup } = await import("@/lib/dev-auto-setup");
    await runDevAutoSetup();
  } catch (err) {
    console.warn("[dev-auto-setup] boot hook failed:", err);
  }
  // After dev-auto-setup has ensured the dev org + connector wiring exists, apply
  // each extension's declared cinatra.devFixtures into its own org-scoped surfaces
  // so a freshly-installed extension is visible on this dev boot. Soft-fail +
  // idempotent; never blocks boot.
  try {
    const { runDevFixtureSeeder } = await import("@/lib/dev-fixture-seeder");
    await runDevFixtureSeeder();
  } catch (err) {
    console.warn("[dev-fixture-seeder] boot hook failed:", err);
  }
}
