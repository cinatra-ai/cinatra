import "server-only";

// ---------------------------------------------------------------------------
// ADMISSION-POLICY GENERATION (cinatra#2817 slice 2).
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

const HISTORY_LIMIT = 100;

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
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
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
type StateHolder = { [k: symbol]: AdmissionGenerationState | undefined };
const _holder = globalThis as unknown as StateHolder;
const _state: AdmissionGenerationState =
  _holder[ADMISSION_GENERATION_KEY] ??
  (_holder[ADMISSION_GENERATION_KEY] = new AdmissionGenerationState());

/** The current admission-policy generation. */
export function getAdmissionPolicyGeneration(): number {
  return _state.current();
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
  return _state.bump(reason, packageName);
}

/** Generation + recent transitions, for the operator control-plane surface. */
export function getAdmissionPolicySnapshot(): AdmissionPolicySnapshot {
  return _state.snapshot();
}

/** @internal Tests only. */
export function __resetAdmissionPolicyGenerationForTests(): void {
  _state.reset();
}
