// Boot-phase orchestration primitives (engineering #302).
//
// `src/instrumentation.node.ts` used to inline ~30 boot side-effect blocks, each
// with its own ad-hoc try/catch + log + (rarely) rethrow. This module gives those
// blocks a SINGLE, declared shape: a `BootPhase` with an explicit failure POLICY,
// run through `runBootPhase`, which records the outcome in the boot-state surface
// so a failed phase is visible to health checks and operators.
//
// The point is NOT to change boot behavior — it is to make each block's existing
// failure handling EXPLICIT and uniform:
//
//   - `fatal`     : a failure aborts boot (the runner rethrows). Used for the
//                   blocks that already rethrew in production (core migrations,
//                   required-activation assert, closure gate) — the orchestrator
//                   keeps the prod/dev split inside the phase body, so a phase is
//                   only `fatal` when it already threw.
//   - `retryable` : a failure is logged + swallowed; the side effect retries on a
//                   later boot or a per-request lazy path. Matches the dozens of
//                   "non-fatal — retries on next boot" blocks.
//   - `degraded`  : a failure is logged + swallowed; the process serves with
//                   reduced functionality (e.g. telemetry off, a worker not
//                   registered). Same swallow as `retryable`; the label tells the
//                   operator the deficit is durable for this process lifetime.
//   - `dev-only`  : the phase only runs in development; its failure is always
//                   swallowed (prod never executes it).
//
// `retryable` and `degraded` produce IDENTICAL runtime behavior (log + continue);
// they differ only in the recorded reason an operator reads. This preserves the
// existing boot semantics exactly while making the intent legible.
//
// Deliberately NOT importing "server-only": vitest unit tests import this module
// directly (mirrors core-migrations.ts).

import { recordBootPhaseResult } from "@/lib/boot/boot-state";

/** The declared failure policy of a boot phase. See the module docstring. */
export type BootPhasePolicy = "fatal" | "degraded" | "retryable" | "dev-only";

/** The terminal status of a single boot phase run. */
export type BootPhaseStatus = "ok" | "skipped" | "failed";

/** The recorded outcome of one boot phase. */
export type BootPhaseResult = {
  name: string;
  policy: BootPhasePolicy;
  status: BootPhaseStatus;
  /** Why the phase was skipped or failed, when applicable. */
  reason?: string;
  /** Epoch millis the phase finished. */
  at: number;
  /** Wall-clock duration of the phase body, in milliseconds. */
  durationMs: number;
};

/** The non-throwing result of a phase body: complete (void) or a `{ skipped }` no-op. */
export type BootPhaseOutcome = void | { skipped: string };

/** A single boot phase: a named, policy-tagged unit of startup work. */
export type BootPhase = {
  /** Stable identifier surfaced to health/operators (e.g. "core-migrations"). */
  name: string;
  /** What happens to boot when `run` throws. */
  policy: BootPhasePolicy;
  /**
   * The phase body. May return:
   *   - nothing / undefined      -> recorded `ok`
   *   - `{ skipped: <reason> }`  -> recorded `skipped` (a deliberate, non-error
   *                                 no-op such as a fresh-install / kill-switch /
   *                                 not-configured short-circuit)
   * Throwing routes through the policy. The return type is the UNION of those two
   * outcomes (sync or async) so a body that early-returns `{ skipped }` on one path
   * and runs to completion (returning undefined) on another type-checks cleanly.
   */
  run: () => BootPhaseOutcome | Promise<BootPhaseOutcome>;
};

/** Injectable side-effects so tests can assert logging + recording. */
export type RunBootPhaseDeps = {
  record?: (result: BootPhaseResult) => void;
  logError?: (msg: string, err?: unknown) => void;
  now?: () => number;
};

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a single boot phase under its declared policy, recording the outcome.
 *
 * Behavior by policy on a thrown error:
 *   - `fatal`                -> record `failed`, then RETHROW (aborts boot).
 *   - `retryable`/`degraded` -> record `failed`, log, SWALLOW (boot continues).
 *   - `dev-only`             -> record `failed`, log, SWALLOW.
 *
 * A returned `{ skipped }` is recorded as `skipped` (no error). The runner never
 * decides dev-vs-prod fatality itself — a phase that should only abort boot in
 * production keeps that decision inside its `run` body (which then either throws,
 * making this `fatal` phase abort, or returns, making it `ok`). This preserves the
 * existing per-block prod/dev policy verbatim.
 */
export async function runBootPhase(
  phase: BootPhase,
  deps: RunBootPhaseDeps = {},
): Promise<BootPhaseResult> {
  const {
    record = recordBootPhaseResult,
    logError = (msg, err) => console.error(msg, err ?? ""),
    now = () => Date.now(),
  } = deps;

  const startedAt = now();

  const finish = (status: BootPhaseStatus, reason?: string): BootPhaseResult => {
    const finishedAt = now();
    const result: BootPhaseResult = {
      name: phase.name,
      policy: phase.policy,
      status,
      ...(reason ? { reason } : {}),
      at: finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
    };
    record(result);
    return result;
  };

  try {
    const outcome = await phase.run();
    if (outcome && typeof outcome === "object" && "skipped" in outcome) {
      return finish("skipped", outcome.skipped);
    }
    return finish("ok");
  } catch (err) {
    const reason = reasonOf(err);
    const result = finish("failed", reason);
    if (phase.policy === "fatal") {
      logError(`[boot] phase "${phase.name}" FAILED (fatal — aborting boot):`, err);
      throw err;
    }
    logError(
      `[boot] phase "${phase.name}" failed (${phase.policy} — boot continues):`,
      err,
    );
    return result;
  }
}
