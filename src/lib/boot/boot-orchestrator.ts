// Boot orchestrator (engineering #302).
//
// `instrumentation.node.ts#register()` used to BE the implementation body for
// every boot side effect (~30 inline blocks). This module is the orchestrator: it
// runs the extracted phase modules in the SAME order, through the policy-aware
// `runBootPhase` runner, recording each outcome in the boot-state readiness
// surface. `register()` becomes a thin shim: install fatal handlers, guard the
// build phase, then `await runBoot()`.
//
// ORDER IS PRESERVED VERBATIM from the original file (see the inline markers).
// The two dev blocks that were DETACHED (fire-and-forget) stay detached AND keep
// their ORIGINAL, DIFFERENT interleave points: block 1 (agents/skills scan) fires
// EARLY (right after install-op cleanup, before the always-on system services);
// block 2 (dev-auto-setup) fires LAST (the trailing statement). Both are started
// WITHOUT awaiting so the dev server still starts serving ~18s sooner.
//
// Deliberately NOT importing "server-only": vitest unit tests import this module.

import { beginBoot, markBootReady } from "@/lib/boot/boot-state";
import { runBootPhase, type BootPhase } from "@/lib/boot/boot-phase";
import { coreBootPhases } from "@/lib/boot/phases/core-boot";
import { extensionActivationPhases } from "@/lib/boot/phases/extension-activation";
import { requiredExtensionMaterializePhases } from "@/lib/boot/phases/required-extension-materialize";
import { agentMarkerBackfillPhases } from "@/lib/boot/phases/agent-marker-backfill";
import { systemServicesPhases } from "@/lib/boot/phases/system-services";
import { systemLoopPhases } from "@/lib/boot/phases/system-loops";
import {
  devAwaitedPhases,
  startDetachedDevAgentsScanPhase,
  startDetachedDevAutoSetupPhase,
} from "@/lib/boot/phases/dev-boot";
import type { ActivationResult } from "@cinatra-ai/sdk-extensions";

/** Injectable seams so the orchestrator sequence is unit-testable. */
export type RunBootDeps = {
  isDevMode?: () => boolean;
  runPhase?: typeof runBootPhase;
  startDetachedAgentsScan?: typeof startDetachedDevAgentsScanPhase;
  startDetachedAutoSetup?: typeof startDetachedDevAutoSetupPhase;
};

function inDevMode(): boolean {
  return process.env.CINATRA_RUNTIME_MODE === "development";
}

/**
 * Run the full boot sequence. Mirrors the original `register()` body order
 * exactly. Each phase is recorded in the boot-state surface; a `fatal` phase that
 * throws aborts boot (the throw propagates out of `register()` as before).
 */
export async function runBoot(deps: RunBootDeps = {}): Promise<void> {
  const {
    isDevMode = inDevMode,
    runPhase = runBootPhase,
    startDetachedAgentsScan = startDetachedDevAgentsScanPhase,
    startDetachedAutoSetup = startDetachedDevAutoSetupPhase,
  } = deps;

  beginBoot();
  const dev = isDevMode();

  const run = async (phases: BootPhase[]): Promise<void> => {
    for (const phase of phases) {
      await runPhase(phase);
    }
  };

  // Shared activation-results accumulator threaded through the dual loaders and
  // consumed by the required-activation assert (preserves the original shared
  // `bootActivationResults` array semantics exactly).
  const bootActivationResults: ActivationResult[] = [];

  // ── core boot: DI wiring, migrations, cache warm, identity, marketplace ──────
  await run(coreBootPhases());

  // ── extension activation: dual loaders + required-set enforcement + cleanup ──
  await run(extensionActivationPhases(bootActivationResults));

  // ── required-extension OAS materialize (cinatra-ai/ops#436) ───────────────────
  // PROD: fail-closed reconcile of the image-baked required-extension OAS seed
  // into the live agent-install dir, so a new image tag REFRESHES the on-disk
  // `<vendor>/<slug>/cinatra/oas.json` trees that WayFlow + the host scan (the
  // ops#431 frozen-volume regression). Runs AFTER core boot (DB/identity) and
  // BEFORE the marker backfill below, so markers backfill against the freshly
  // materialized tree. DEV: non-fail-closed no-op when no seed is baked (the dev
  // git-native scan owns the tree). `fatal` policy — the dev/prod split is in the
  // phase body, so it only aborts boot in production.
  await run(requiredExtensionMaterializePhases());

  // ── agent published-marker self-heal (engineering #418) ──────────────────────
  // PROD-SAFE, always-on (dev AND prod). AWAITED here — before the dev detached
  // scan starts and before markBootReady() — so every installed agent's
  // `.cinatra-published.json` marker is present + matches its `oas.json` by the
  // time wayflow's loader scans. Idempotent / never clobbers a valid marker /
  // skips in-progress drafts (see the phase module). `degraded`: a failure logs
  // and boot continues (an unrepairable agent stays gated, as it did pre-#418).
  await run(agentMarkerBackfillPhases());

  // ── dev block 1 (DETACHED in the original — agents/skills scan ~18s) ─────────
  // Original interleave point: right after install-op cleanup, before the
  // always-on system services. Fire-and-forget; NOT awaited. The marker backfill
  // it used to perform is now the always-on `agent-marker-backfill` phase above;
  // the detached scan keeps the dev-only git-native agent ingest + skill loading
  // + hot-reload watcher.
  if (dev) startDetachedAgentsScan();

  // ── system services, part 1: assistant bootstrap + otel ──────────────────────
  const services = systemServicesPhases();
  await run(services.slice(0, 2)); // assistant-bootstrap, otel-tracing

  // ── a2a dev peers (AWAITED in the original) ──────────────────────────────────
  // Original interleave point: between otel and the usage subscriber.
  if (dev) await run(devAwaitedPhases());

  // ── system services, part 2: usage subscriber + anthropic skill map ──────────
  await run(services.slice(2)); // usage-event-subscriber, anthropic-skill-sync-map

  // ── system loops: 7 BullMQ seeds + eager worker + workflows + relocation ─────
  await run(systemLoopPhases());

  // Boot reached its serving prerequisites: the eager worker + runtime engines are
  // wired and the required-set was enforced. Mark ready (degraded if any
  // degraded/retryable phase failed). The detached dev blocks are NOT part of the
  // readiness contract (they were always fire-and-forget).
  markBootReady();

  // ── dev block 2 (DETACHED in the original — dev-auto-setup + fixtures) ────────
  // Original interleave point: the VERY END of register(), after everything else.
  // Fire-and-forget; NOT awaited. Placed after markBootReady() to match the
  // original (it was the trailing statement and is not a readiness prerequisite).
  if (dev) startDetachedAutoSetup();
}
