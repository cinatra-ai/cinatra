// PROCESS-LOCAL boot / readiness state (engineering #302).
//
// Records the outcome of each boot phase (see boot-phase.ts) so a phase failure is
// VISIBLE to health checks and operators — closing the gap where the old boot
// fire-and-forget'd most work and a failed block left no operator-readable trace.
//
// READINESS contract:
//   - `booting`  : `register()` has started but not yet reached the ready marker.
//   - `ready`    : boot completed; the process is serving (the eager BullMQ worker
//                  + runtime engines are wired). This is `markBootReady()`.
//   - `degraded` : boot completed BUT at least one `degraded`/`retryable` phase
//                  failed — the process serves with reduced functionality. The
//                  HTTP health probe still reports healthy (the app serves), but
//                  the snapshot lists the failed phases so an operator sees the
//                  deficit.
//   - `failed`   : a `fatal` phase aborted boot (the process is expected to exit).
//
// PROCESS-LOCAL: this reflects THIS node's in-memory boot, not a cluster-wide
// truth. Cross-compilation singleton: Next.js builds separate bundler
// compilations (instrumentation writes the state; the route compilation reads it
// at request time), so the state MUST be a true per-process singleton, anchored on
// a namespaced+versioned `Symbol.for(...)` key — same pattern as
// extension-activation-generation.ts / extension-mcp-registry.ts.
//
// Deliberately NOT importing "server-only": vitest unit tests import this module
// directly.

import type { BootPhaseResult } from "@/lib/boot/boot-phase";

/** The overall readiness of the process. */
export type BootReadiness = "booting" | "ready" | "degraded" | "failed";

/** A read-only snapshot of the process boot/readiness state. */
export type BootStateSnapshot = {
  /** PROCESS-LOCAL: this node's in-memory boot, not cluster-wide truth. */
  scope: "process-local";
  readiness: BootReadiness;
  /** Epoch millis `register()` started, or null if boot has not started. */
  startedAt: number | null;
  /** Epoch millis boot reached the ready marker, or null if not yet ready. */
  readyAt: number | null;
  /** Every recorded phase outcome, in completion order. */
  phases: readonly BootPhaseResult[];
  /** The names of `degraded`/`retryable` phases that failed (operator deficit list). */
  degradedPhases: readonly string[];
  /** The name of the `fatal` phase that aborted boot, when readiness is "failed". */
  fatalPhase?: string;
};

class BootState {
  private readiness: BootReadiness = "booting";
  private startedAt: number | null = null;
  private readyAt: number | null = null;
  private phases: BootPhaseResult[] = [];

  begin(at: number): void {
    // Idempotent across dev hot-reload re-invocations of register(): the first
    // begin() wins the startedAt; a re-begin resets the phase log for the new pass.
    this.readiness = "booting";
    this.startedAt = at;
    this.readyAt = null;
    this.phases = [];
  }

  recordPhase(result: BootPhaseResult): void {
    this.phases.push(result);
    if (result.status === "failed") {
      if (result.policy === "fatal") {
        this.readiness = "failed";
        return;
      }
      // degraded/retryable failure -> the process serves degraded. Do NOT
      // downgrade a "ready" that was already reached by a later marker; the
      // ready marker re-derives readiness from the phase log.
      if (this.readiness !== "failed") {
        this.readiness = "degraded";
      }
    }
  }

  markReady(at: number): void {
    if (this.readiness === "failed") return; // a fatal phase already aborted boot
    this.readyAt = at;
    this.readiness = this.hasDegradedFailure() ? "degraded" : "ready";
  }

  private hasDegradedFailure(): boolean {
    return this.phases.some(
      (p) => p.status === "failed" && (p.policy === "degraded" || p.policy === "retryable"),
    );
  }

  snapshot(): BootStateSnapshot {
    const degradedPhases = this.phases
      .filter(
        (p) => p.status === "failed" && (p.policy === "degraded" || p.policy === "retryable"),
      )
      .map((p) => p.name);
    const fatal = this.phases.find((p) => p.status === "failed" && p.policy === "fatal");
    return {
      scope: "process-local",
      readiness: this.readiness,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      phases: [...this.phases],
      degradedPhases,
      ...(fatal ? { fatalPhase: fatal.name } : {}),
    };
  }

  reset(): void {
    this.readiness = "booting";
    this.startedAt = null;
    this.readyAt = null;
    this.phases = [];
  }
}

// PROCESS-LOCAL SINGLETON anchored on a namespaced+versioned Symbol so the
// instrumentation compilation (writer) and the route compilation (reader) share
// ONE instance per process. Versioned so a future shape change is a new key.
const BOOT_STATE_SINGLETON_KEY = Symbol.for("@cinatra-ai/host:boot-state@1");

type GlobalWithBootState = typeof globalThis & {
  [BOOT_STATE_SINGLETON_KEY]?: BootState;
};

function getBootState(): BootState {
  const g = globalThis as GlobalWithBootState;
  if (!g[BOOT_STATE_SINGLETON_KEY]) {
    g[BOOT_STATE_SINGLETON_KEY] = new BootState();
  }
  return g[BOOT_STATE_SINGLETON_KEY]!;
}

/** Mark the start of a boot pass (called once at the top of `register()`). */
export function beginBoot(now: () => number = () => Date.now()): void {
  getBootState().begin(now());
}

/** Record a completed phase outcome (called by the boot-phase runner). */
export function recordBootPhaseResult(result: BootPhaseResult): void {
  getBootState().recordPhase(result);
}

/** Mark boot as ready (called once boot's serving prerequisites are wired). */
export function markBootReady(now: () => number = () => Date.now()): void {
  getBootState().markReady(now());
}

/** Read the current process-local boot/readiness snapshot. */
export function getBootStateSnapshot(): BootStateSnapshot {
  return getBootState().snapshot();
}

/** TEST-ONLY: reset the singleton between unit tests. */
export function __resetBootStateForTests(): void {
  getBootState().reset();
}
