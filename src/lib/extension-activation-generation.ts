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
  | "teardown"
  // cinatra#1040 S4: an atomic default re-election (a package's default version
  // changed; global names moved from the old default to the new).
  | "reelect-default";

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

// ---------------------------------------------------------------------------
// ADMISSION-POLICY GENERATION (cinatra#2817 slice 2).
//
// THE SECOND COUNTER, IN THE SAME FILE AS THE FIRST. It shipped as its own
// module and is folded in here because the two axes are read together by
// every cache that keys on either, the state shape and the cross-compilation
// `Symbol.for` anchoring below are the same pattern, and a reader comparing
// the two axes should not have to open two files. The counters stay SEPARATE
// singletons under separate keys — this is one home, not one counter.
//
// The SECOND invalidation axis, beside the extension control-plane generation
// (`extension-activation-generation.ts`). One counter is not enough, because
// the two things that can change what a primitive may do change independently:
//
//   ACTIVATION GENERATION  which primitives EXIST — activate, hot-update,
//                          rollback, uninstall, default re-election.
//   ADMISSION GENERATION   what the host has APPROVED about them — a review
//                          landing, a marketplace revocation, a declaration
//                          change, a migration writing the core records.
//
// A revocation bumps no lifecycle transition, so a cache keyed on activation
// alone would keep serving a revoked primitive until something unrelated
// happened to be installed. That is the exact hole this closes: every cache
// holding a primitive plan, a handler, a catalog entry or an admission decision
// keys on BOTH generations AND the snapshot's content digest, so an invalidation
// cannot be missed by a cache that never saw the bump.
//
// PROCESS-LOCAL, and honestly so — it reflects this process's view, exactly
// like the activation generation. The content digest on the snapshot is what
// makes a cross-process divergence detectable rather than silent: two processes
// at the same counter but different record sets have different digests, so
// nothing built under one is mistaken for the other.
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache, so the
// counter is anchored on a namespaced+versioned `Symbol.for(...)` key — the same
// pattern as the activation generation and the extension MCP registry.
// ---------------------------------------------------------------------------

/**
 * Why the admission policy changed. A truthful label of what a cache is being
 * told to stop trusting.
 */
export type AdmissionPolicyTransition =
  /** The migration wrote (or rewrote) the release-versioned core records. */
  | "core-migration"
  /** A marketplace/host review admitted a declaration. */
  | "admit"
  /** A marketplace/host revocation withdrew one. */
  | "revoke"
  /** A registration's declaration changed, so its old digest no longer applies. */
  | "declaration-change"
  /** The durable store could not be read or written — trust nothing derived. */
  | "store-fault";

export type AdmissionPolicyTransitionRecord = {
  /** The generation value AFTER this bump. */
  generation: number;
  reason: AdmissionPolicyTransition;
  /** The package the transition concerned, when scoped to one. */
  packageName?: string;
  at: number;
};

export type AdmissionPolicySnapshot = {
  generation: number;
  /** Most-recent transitions, newest LAST, bounded. */
  lastTransitions: readonly AdmissionPolicyTransitionRecord[];
};

const ADMISSION_HISTORY_LIMIT = 100;

class AdmissionGenerationState {
  private generation = 0;
  private history: AdmissionPolicyTransitionRecord[] = [];

  current(): number {
    return this.generation;
  }

  bump(reason: AdmissionPolicyTransition, packageName?: string): number {
    this.generation += 1;
    this.history.push({
      generation: this.generation,
      reason,
      ...(packageName ? { packageName } : {}),
      at: Date.now(),
    });
    if (this.history.length > ADMISSION_HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - ADMISSION_HISTORY_LIMIT);
    }
    return this.generation;
  }

  snapshot(): AdmissionPolicySnapshot {
    return {
      generation: this.generation,
      lastTransitions: this.history.map((r) => ({ ...r })),
    };
  }

  reset(): void {
    this.generation = 0;
    this.history = [];
  }
}

const ADMISSION_GENERATION_KEY = Symbol.for(
  "@cinatra-ai/host:delegated-chat-admission-generation/v1",
);
type AdmissionStateHolder = { [k: symbol]: AdmissionGenerationState | undefined };
const _admissionHolder = globalThis as unknown as AdmissionStateHolder;
const _admissionState: AdmissionGenerationState =
  _admissionHolder[ADMISSION_GENERATION_KEY] ??
  (_admissionHolder[ADMISSION_GENERATION_KEY] = new AdmissionGenerationState());

/** The current admission-policy generation. */
export function getAdmissionPolicyGeneration(): number {
  return _admissionState.current();
}

/**
 * Bump the admission-policy generation and return the new value.
 *
 * SYNCHRONOUS and called at the OUTCOME point of the change, never via a
 * detached `void async`: the bump IS the invalidation signal, so a bump that
 * lands after the next request has already read the old state is not an
 * invalidation, it is a race.
 */
export function bumpAdmissionPolicyGeneration(
  reason: AdmissionPolicyTransition,
  packageName?: string,
): number {
  return _admissionState.bump(reason, packageName);
}

/** Generation + recent transitions, for the operator control-plane surface. */
export function getAdmissionPolicySnapshot(): AdmissionPolicySnapshot {
  return _admissionState.snapshot();
}

/** @internal Tests only. */
export function __resetAdmissionPolicyGenerationForTests(): void {
  _admissionState.reset();
}
