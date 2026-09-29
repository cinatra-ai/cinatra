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
// ONE EXCEPTION, and it is deliberate (cinatra#3626). The first of those two
// detached blocks opened with the git-native AGENT INGEST: the walk that reads
// the agent definitions committed under the extension source tree into the
// database. Detached, that ingest finished some seconds after the boot had
// reached its ready marker, so an instance that had just been prepared reported
// itself READY while its agent rows were still filling in, and the way to get a
// complete one was to start it a second time.
//
// WHAT AWAITING MOVES, precisely. In development the whole boot is detached from
// `register()` (`src/lib/boot/register-await-policy.ts:36`,
// `src/lib/boot/start-boot.ts:105-123`), so the development server serves while
// the boot runs either way — awaiting this phase does NOT hold requests. What it
// moves is the READY marker: the phase now completes before `markBootReady()`,
// so `/api/health` answers `starting` / 503 until the definitions are on file
// and a poller that waits for ready gets an instance that carries them.
//
// The ingest is therefore its own AWAITED phase (`devAgentIngestPhases`), and
// the rest of that block — the skill-package load, the catalog rebuild and the
// hot-reload watcher, none of which the instance's agent rows depend on — keeps
// the detachment (`startDetachedDevExtensionsPhase`). One start is enough, and
// the cost on a restart is the one the loader's version-skip already carries:
// one read per definition, plus the declared-tables activation that runs above
// that skip (cinatra#3462).
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
 * The git-native AGENT INGEST, AWAITED (cinatra#3626).
 *
 * Returned as a `BootPhase` so the orchestrator runs it through the normal
 * runner, at the interleave point dev BLOCK 1 always had (right after the
 * install-op cleanup, before the always-on system services) and — the point of
 * the change — before `markBootReady()`. The always-on `agent-marker-backfill`
 * phase still runs BEFORE it, so every on-disk agent already carries a valid
 * marker by the time the definitions are read in.
 *
 * `dev-only`: production never executes it, and the runner logs and swallows a
 * failure. What a failure leaves behind is a RECORDED phase: `boot-state` folds
 * only `degraded` and `retryable` failures into readiness and into the
 * `degradedPhases` / `blockingPhases` lists (`src/lib/boot/boot-state.ts:93-112`),
 * and `/api/health` reports exactly those lists
 * (`src/app/api/health/route.ts:43-51`). So a failed ingest is in the log and in
 * the process-local phase log, and it changes neither readiness nor the health
 * answer — a development-only step must not be able to fail a deploy gate.
 *
 * An instance with no extension source tree at all records the phase as SKIPPED
 * rather than failed: a minimal deployment has nothing to read in, which is not
 * a fault.
 *
 * BOUNDED. The walk carries its own budget
 * (`GIT_NATIVE_AGENT_INGEST_BUDGET_MS`) and reports what it did not reach, and
 * this phase turns that into a failure naming the definitions still pending.
 * Without it a loader that never returns would sit here until the boot-stall
 * watchdog collected it, and that watchdog's development arm exits the process
 * (`src/lib/boot/boot-stall-watchdog.ts:33`) — a development-only convenience
 * must not be able to kill a development server.
 *
 * A definition the loader cannot read is named and the remaining definitions are
 * still read in — see `@/lib/git-native-agent-ingest`.
 */
export function devAgentIngestPhases(): BootPhase[] {
  return [
    {
      name: "dev-agent-ingest",
      policy: "dev-only",
      run: async () => {
        const { existsSync } = await import("node:fs");
        const { resolveDevExtensionSourceRoot } = await import(
          "@cinatra-ai/agents/agent-runtime-mount"
        );
        const sourceRoot = resolveDevExtensionSourceRoot();
        if (!existsSync(sourceRoot)) {
          return { skipped: "no extension source tree to read agent definitions from" };
        }

        const { ingestGitNativeAgentDefinitions, GIT_NATIVE_AGENT_INGEST_BUDGET_MS } =
          await import("@/lib/git-native-agent-ingest");
        const report = await ingestGitNativeAgentDefinitions({ sourceRoot });
        console.info(
          `[agent-builder] git-native agent definitions: ${report.found} found, ` +
            `${report.imported} read in, ${report.alreadyOnFile} already on file` +
            (report.declined > 0 ? `, ${report.declined} declined` : "") +
            (report.failures.length > 0 ? `, ${report.failures.length} not read in` : "") +
            (report.pending.length > 0
              ? `, ${report.pending.length} still pending at the ${GIT_NATIVE_AGENT_INGEST_BUDGET_MS} ms budget`
              : ""),
        );
        if (report.pending.length > 0) {
          // Recorded as a phase failure (logged and swallowed by the `dev-only`
          // policy, readiness untouched) so the definitions that were not
          // reached are named where an operator looks, instead of read off a
          // row count.
          throw new Error(
            `the git-native agent ingest ran out of its ${GIT_NATIVE_AGENT_INGEST_BUDGET_MS} ms ` +
              `budget with ${report.pending.length} definition(s) still pending: ` +
              `${report.pending.join(", ")}`,
          );
        }
        return undefined;
      },
    },
  ];
}

/**
 * Start the DETACHED remainder of dev BLOCK 1 (fire-and-forget): the SKILL-kind
 * extension package load, the lifecycle catalog rebuild and the recursive
 * hot-reload watcher. Returns immediately so `register()` is not blocked — that
 * detachment is the whole point, and nothing the instance's agent rows depend on
 * is in here (the ingest that was is now the awaited phase above).
 *
 * The published-marker backfill + WayFlow reload this block used to perform was
 * promoted to the always-on `agent-marker-backfill` boot phase (engineering
 * #418) so PROD installs self-heal too.
 *
 * Errors are self-contained (the inner try/catch logs + swallows; the runner is
 * the net). NOT awaited by the orchestrator.
 */
export function startDetachedDevExtensionsPhase(): void {
  void runBootPhase({
    name: "dev-extensions-scan",
    policy: "dev-only",
    run: async () => {
      await runDevExtensionsScan();
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

// ── Block 1 body, detached remainder (the skill half of the original IIFE) ───
async function runDevExtensionsScan(): Promise<void> {
  // Dev-mode: load SKILL-kind extension packages at boot (the awaited agent
  // ingest above only covers agent kind) AND start the recursive hot-reload
  // watcher so live edits/additions under extensions/ surface without a server
  // restart.
  try {
    const { resolveDevExtensionSourceRoot } = await import("@cinatra-ai/agents/agent-runtime-mount");
    const {
      loadAllSkillPackagesAtBoot,
      startDevExtensionsWatcher,
    } = await import("@/lib/extensions-dev-watcher");
    const extRoot = resolveDevExtensionSourceRoot();
    await loadAllSkillPackagesAtBoot(extRoot);
    // Explicit lifecycle rebuild (cinatra#1364): the always-on boot rebuild
    // phase ran BEFORE this detached dev scan, so re-run it after the dev
    // skill-package load registered the extension skills.
    const { rebuildSkillsCatalog } = await import("@cinatra-ai/skills/skill-packages");
    await rebuildSkillsCatalog({ reason: "boot-dev-extensions-scan" });
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
  // Extension dev-fixtures RELOCATION (`cinatra install demo`; cinatra-cli#122):
  // the dev-fixtures dataset is now demo-MANDATORY / dev-OPT-IN — it is no longer
  // seeded on every dev boot. Gate the seeder CALL here (the primary gate); the
  // seeder ALSO self-guards on the same decision (defense in depth) so no future
  // caller can leak fixtures into a plain dev boot. dev-auto-setup above is
  // DELIBERATELY unaffected: connector wiring / auto-connect still runs on every
  // dev boot so a demo's bundled apps connect once their containers are up.
  const { shouldSeedDevFixtures } = await import("@/lib/install-profile");
  if (!shouldSeedDevFixtures()) {
    console.info(
      "[dev-fixture-seeder] skipped — extension dev-fixtures seed only in demo " +
        "(CINATRA_INSTALL_PROFILE=demo) or when opted in for dev (CINATRA_DEV_FIXTURES=1).",
    );
    return;
  }
  // Apply each extension's declared cinatra.devFixtures into its own org-scoped
  // surfaces so a freshly-installed extension is visible on this boot. Soft-fail +
  // idempotent; never blocks boot.
  try {
    const { runDevFixtureSeeder } = await import("@/lib/dev-fixture-seeder");
    await runDevFixtureSeeder();
  } catch (err) {
    console.warn("[dev-fixture-seeder] boot hook failed:", err);
  }
  // Demo overlay (cinatra#1238 item 3): on a strict-dev `CINATRA_INSTALL_PROFILE=demo`
  // instance, once a HUMAN admin has registered, lazily fire the monolithic ACME
  // demo dataset exactly once. Runs LAST — after connections have converged
  // (dev-auto-setup above) and the extension fixtures are applied — and self-gates
  // to a no-op on a plain dev/prod instance or before the first human admin exists.
  // Soft-fail + idempotent (the seed's own sentinel org gates re-runs); never
  // blocks boot. Reached only when shouldSeedDevFixtures() is true, which demo
  // always satisfies (the early return above only fires on a non-demo instance,
  // where the demo seed would skip regardless).
  try {
    const { runPendingDemoSeedFromBoot } = await import("@/lib/demo-seed-runner");
    const outcome = await runPendingDemoSeedFromBoot();
    if (outcome.status === "error") {
      console.warn("[demo-seed] boot runner error:", outcome.reason);
    }
  } catch (err) {
    console.warn("[demo-seed] boot hook failed:", err);
  }
}
