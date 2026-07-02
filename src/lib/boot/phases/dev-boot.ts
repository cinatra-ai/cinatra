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
 * scan (git-native agent ingest) + skill-package load + hot-reload watcher (~18s
 * of dev-only work). Returns immediately so `register()` is not blocked. The
 * ORIGINAL boot fired this block at the EARLY interleave point (right after
 * install-op cleanup, before the always-on system services); the orchestrator
 * calls it there.
 *
 * The published-marker backfill + WayFlow reload that this block used to perform
 * was promoted to the always-on `agent-marker-backfill` boot phase (engineering
 * #418) so PROD installs self-heal too; the orchestrator AWAITS that phase before
 * starting this detached scan, so markers are already valid by the time the
 * git-native ingest below runs.
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
    } = await import("@cinatra-ai/agents");
    const { resolveAgentInstallDir } = await import("@cinatra-ai/agents/agent-install-path");
    const agentsDir = resolveAgentInstallDir();

    // NOTE: `.cinatra-published.json` marker backfill (+ post-backfill wayflow
    // reload) now runs in the always-on `agent-marker-backfill` boot phase
    // (engineering #418), which the orchestrator AWAITS BEFORE starting this
    // detached dev scan — so by the time the git-native ingest below runs (and
    // by the time wayflow scans), every on-disk agent already has a valid marker
    // in BOTH dev and prod. Do not re-run the backfill here (it would be a
    // redundant second pass on the same tree).

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
              await ensureAgentPackageFromGitFile({ oasSourcePath: target, licenseAcknowledged: true });
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
          await ensureAgentPackageFromGitFile({ oasSourcePath: cinatraAgentJson, licenseAcknowledged: true });
        } catch (fileErr) {
          console.warn(`[agent-builder] git agent load skipped (${entry.name}/cinatra):`, fileErr);
        }
      } else if (existsSync(firstLevelAgentJson)) {
        try {
          await ensureAgentPackageFromGitFile({ oasSourcePath: firstLevelAgentJson, licenseAcknowledged: true });
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
