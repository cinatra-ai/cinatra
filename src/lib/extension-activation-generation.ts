import "server-only";

// First-class CONTROL-PLANE GENERATION for the extension activation state.
//
// A single monotonic counter that increments on every relevant extension
// lifecycle transition (boot activation, install/activate, hot-update, rollback,
// and teardown — archive/uninstall/force-delete/purge route through the in-process
// capability-teardown hook). The generation is the FIRST-CLASS invalidation key
// the host-owned in-process caches consult instead of ad-hoc `reset` calls: a
// cache compares the generation it was built at against the current generation and
// rebuilds iff they differ (see `extension-self-mcp.ts`).
//
// NAMING (codex round-1): this is the CONTROL-PLANE generation, not strictly an
// "activation" generation — teardown changes it too. The export names keep
// "activation" only because the lifecycle surface is colloquially "activation
// state"; the docstrings and the operator endpoint label it the control-plane
// generation. It is PROCESS-LOCAL: it reflects this process's in-memory registry
// state, NOT a cluster-wide truth.
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. The loader
// bumps the generation at boot (instrumentation compilation); the MCP route + the
// operator endpoint read it at request time (route compilation) — so the counter
// MUST be a true per-process singleton, anchored on a namespaced+versioned
// `Symbol.for(...)` key (same pattern as `extension-mcp-registry.ts`).

/**
 * The lifecycle transitions that bump the control-plane generation. A truthful
 * label of WHY the live extension registry set changed (or may have changed):
 *  - `boot-static`   : the StaticBundleLoader boot pass completed.
 *  - `boot-runtime`  : the RuntimePackageLoader boot pass completed.
 *  - `activate`      : a single package was targeted-activated in-process (fresh
 *                      install OR a re-activate / restore — targeted activation is
 *                      not always a fresh install).
 *  - `hot-update`    : a superseding hot-update activated the new digest.
 *  - `rollback`      : a failed hot-update durably rolled back to the old digest.
 *  - `teardown`      : the in-process capability-teardown hook removed a package's
 *                      registrations (fired by archive / uninstall / force-delete /
 *                      purge — and defensively before a re-activate; the bump is
 *                      guarded on ACTUAL removals so a no-op teardown does not emit
 *                      a spurious generation).
 */
export type ActivationTransition =
  | "boot-static"
  | "boot-runtime"
  | "activate"
  | "hot-update"
  | "rollback"
  | "teardown";

/** A recorded transition in the bounded history ring. */
export type ActivationTransitionRecord = {
  /** The generation value AFTER this transition's bump. */
  generation: number;
  reason: ActivationTransition;
  /** The package the transition concerned, when scoped to one (else undefined). */
  packageName?: string;
  /** Epoch millis the bump happened. */
  at: number;
};

/** A read-only snapshot of the control-plane generation + recent transitions. */
export type ActivationControlPlaneSnapshot = {
  generation: number;
  /** The most-recent transitions, newest LAST, bounded to `HISTORY_LIMIT`. */
  lastTransitions: readonly ActivationTransitionRecord[];
};

// Bounded ring of recent transitions (codex: a small fixed buffer, 50–100). 100
// is enough to span a busy install/update batch without unbounded growth.
const HISTORY_LIMIT = 100;

class ActivationGenerationState {
  private generation = 0;
  private history: ActivationTransitionRecord[] = [];

  current(): number {
    return this.generation;
  }

  bump(reason: ActivationTransition, packageName?: string): number {
    this.generation += 1;
    const record: ActivationTransitionRecord = {
      generation: this.generation,
      reason,
      ...(packageName ? { packageName } : {}),
      at: Date.now(),
    };
    this.history.push(record);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    return this.generation;
  }

  snapshot(): ActivationControlPlaneSnapshot {
    return {
      generation: this.generation,
      // Copy so a caller cannot mutate the internal ring.
      lastTransitions: this.history.map((r) => ({ ...r })),
    };
  }

  reset(): void {
    this.generation = 0;
    this.history = [];
  }
}

const ACTIVATION_GENERATION_KEY = Symbol.for(
  "@cinatra-ai/host:extension-activation-generation/v1",
);
type StateHolder = { [k: symbol]: ActivationGenerationState | undefined };
const _holder = globalThis as unknown as StateHolder;
const _state: ActivationGenerationState =
  _holder[ACTIVATION_GENERATION_KEY] ??
  (_holder[ACTIVATION_GENERATION_KEY] = new ActivationGenerationState());

/** The current control-plane generation. Caches compare this to the generation
 *  they were built at and rebuild iff it differs. */
export function getActivationGeneration(): number {
  return _state.current();
}

/**
 * Bump the control-plane generation for a lifecycle transition and return the new
 * value. Synchronous + called at the lifecycle OUTCOME point (codex: never via a
 * fire-and-forget `void async`): the bump BOTH records the transition for operator
 * observability AND is the invalidation signal the generation-keyed caches read.
 */
export function bumpActivationGeneration(
  reason: ActivationTransition,
  packageName?: string,
): number {
  return _state.bump(reason, packageName);
}

/** A read-only snapshot of the generation + recent transitions for the operator
 *  control-plane endpoint. */
export function getActivationControlPlaneSnapshot(): ActivationControlPlaneSnapshot {
  return _state.snapshot();
}

/** @internal Tests only — reset the counter + history. */
export function __resetActivationGenerationForTests(): void {
  _state.reset();
}
