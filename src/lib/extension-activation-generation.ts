import "server-only";

import { randomUUID } from "node:crypto";

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

// ---------------------------------------------------------------------------
// THE ADMISSION REVIEW MOMENT (cinatra#2817).
//
// WHAT IT IS FOR. The uninstall revocation withdraws every admission reviewed
// AT OR BEFORE the moment the teardown ran, so it needs to order one review
// against one teardown. Both used to be `new Date().toISOString()` and the
// comparison was strict, so an uninstall and a same-version reinstall inside
// ONE millisecond produced two EQUAL stamps and the revocation withdrew the
// fresh review — the exact hazard the cutoff exists to prevent.
//
// WHY TWO PARTS AND NOT A FASTER CLOCK. The obvious repair — a clock that
// never returns the same value twice, by handing out `last + 1ms` when the wall
// clock has not moved — buys the ordering by LYING about the time, and the lie
// is fail-OPEN. A stamp minted a few milliseconds ahead of the wall clock
// outlives a teardown that genuinely followed it, because a teardown in another
// process reads the honest clock and mints a LOWER cutoff. An uninstalled
// package keeping an approval is the one outcome this perimeter may not
// produce, so the stamp stays honest and the ordering is carried separately:
//
//   `at`   — the TRUE wall-clock instant, canonical ISO-8601 UTC milliseconds.
//            The only value two PROCESSES can compare, and the audit value.
//   `mint` — `<epoch>.<seq>`: a per-process epoch and a counter that strictly
//            increases within it. Compared ONLY when `at` ties, and ONLY when
//            the epochs match.
//
// WHAT EACH CASE RESOLVES TO. Different milliseconds: the wall clock decides,
// with no skew to be wrong about. Same millisecond, same process: the sequence
// decides, which is the boundary the plain clock got wrong. Same millisecond,
// DIFFERENT processes: nothing can order them, and the answer is to REVOKE.
// That is the fail-closed reading — the marketplace pulled the package, a
// re-review is cheap, and a surviving approval is not.
//
// THE LIMIT THIS DOES NOT REACH, STATED PLAINLY. The last case revokes a
// re-admission it would ideally keep: two processes, one millisecond, no
// shared order. Ordering that pair needs a SHARED SEQUENCER — a store-issued
// token carried into the CAS — and the teardown chokepoint cannot get one. It
// is a SYNCHRONOUS hook, so it cannot read the store before it stamps, and
// reading a durable counter later inside the detached revocation would capture
// the cutoff AFTER the very re-admission it exists to spare, which reopens the
// original race pointing the other way. The residual is therefore inherent to
// a sync hook, and it errs toward a re-review rather than toward a surviving
// approval. cinatra#2937 wires the production admission writer on an ASYNC
// path; that is where both sides can carry a store-issued sequence and close
// this properly.
//
// WHY IT LIVES HERE. The teardown chokepoint already imports this module
// statically: it is the dependency-free leaf it can reach on a SYNC hot path
// without pulling the store graph behind it. The store imports it too. One
// epoch reachable from both mint sites is what makes `mint` mean anything;
// hence the same cross-compilation `Symbol.for` anchoring the generations use,
// so a dual-specifier import cannot split the counter in two.
// ---------------------------------------------------------------------------

/** One reviewed-at moment: an honest instant, plus a tie-break only its own process can read. */
export type AdmissionReviewMoment = {
  /** Canonical ISO-8601 UTC millisecond instant — the true wall clock. */
  readonly at: string;
  /** `<epoch>.<seq>`. Orders two moments ONLY when their epochs are equal. */
  readonly mint: string;
};

const ADMISSION_REVIEW_CLOCK_KEY = Symbol.for(
  "@cinatra-ai/host:delegated-chat-admission-review-clock/v1",
);
type ReviewClock = { epoch: string; seq: number };
type ReviewClockHolder = { [k: symbol]: ReviewClock | undefined };
const _reviewClockHolder = globalThis as unknown as ReviewClockHolder;
const _reviewClock: ReviewClock =
  _reviewClockHolder[ADMISSION_REVIEW_CLOCK_KEY] ??
  (_reviewClockHolder[ADMISSION_REVIEW_CLOCK_KEY] = { epoch: randomUUID(), seq: 0 });

/**
 * Mint the next review moment.
 *
 * `at` is the wall clock, unmodified — this function never invents a time.
 * `seq` strictly increases, so two moments from THIS process are always
 * ordered even when they land in the same millisecond.
 */
export function nextAdmissionReviewMoment(): AdmissionReviewMoment {
  _reviewClock.seq += 1;
  return { at: new Date().toISOString(), mint: `${_reviewClock.epoch}.${_reviewClock.seq}` };
}

/** Split a `<epoch>.<seq>` mint token, or `null` if it is not one. */
function parseMint(mint: unknown): { epoch: string; seq: number } | null {
  if (typeof mint !== "string") return null;
  const cut = mint.lastIndexOf(".");
  if (cut <= 0 || cut === mint.length - 1) return null;
  const seq = Number(mint.slice(cut + 1));
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return { epoch: mint.slice(0, cut), seq };
}

/**
 * Did `review` happen STRICTLY AFTER `cutoff`?
 *
 * `false` for everything it cannot prove, because the caller revokes on
 * `false`: an absent instant, a tie it cannot break, a mint token from another
 * process or from no process at all. The one case that answers `true` on a tie
 * is the one that is provable — same process, higher sequence.
 */
export function admissionReviewIsAfter(
  review: { at?: string; mint?: string } | undefined,
  cutoff: AdmissionReviewMoment,
): boolean {
  if (review?.at === undefined) return false;
  if (review.at > cutoff.at) return true;
  if (review.at < cutoff.at) return false;
  const a = parseMint(review.mint);
  const b = parseMint(cutoff.mint);
  if (!a || !b || a.epoch !== b.epoch) return false;
  return a.seq > b.seq;
}

/** @internal Tests only — a fresh epoch, as if this were another process. */
export function __resetAdmissionReviewClockForTests(): void {
  _reviewClock.epoch = randomUUID();
  _reviewClock.seq = 0;
}
