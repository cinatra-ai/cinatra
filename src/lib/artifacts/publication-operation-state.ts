// Publication-operation state machine — the PURE core of the durable
// publication-operation ledger (cinatra#1450, epic #1448).
//
// A draftable artifact (social post draft, ads draft, email body) is published
// through a durable OPERATION record — never directly. This module is the
// dependency-free heart: the state set, the legal transitions, the CAS guards,
// and the deterministic idempotency-key derivation. It carries NO I/O (no
// `server-only`, no DB, no `@/lib`) so every invariant is unit-tested in CI
// WITHOUT a Postgres — the DB ledger (`publication-ledger.ts`) mirrors each
// guard below into a single conditional SQL statement and is the authority for
// the row; this module is the specification the SQL implements.
//
// The invariants this encodes (issue #1450 acceptance criteria):
//   - schedule → cancel → edit race: a delivery job dispatched for
//     cancellation-generation G can NEVER win the pending→running claim once
//     the operation was cancelled (state left `pending`) or re-scheduled
//     (generation moved past G) — so a stale job cannot publish an unpinned
//     revision (`claim` guard).
//   - idempotent retry / no double-publish: the idempotency key is STABLE
//     across attempts of the same intent (same pinned revision + destination +
//     generation) so a redelivery reuses it and the connector dedupes; it is
//     FRESH across a re-schedule (new generation ⇒ a deliberate new external
//     effect). A second worker cannot re-claim a `running` operation, and a
//     `succeed`/`fail` under a stale generation is refused.
//   - publish-failure leaves the artifact LOCKED: `fail` emits status effect
//     `none` (never `unlock`), so the artifact stays locked with the operation
//     in `failed`; only an explicit `cancel` (unschedule) emits `unlock`.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const PUBLICATION_OPERATION_STATES = [
  "pending", // scheduled, not yet claimed by a delivery worker
  "running", // claimed by exactly one worker; the external publish is in flight
  "succeeded", // published; receipt recorded (terminal)
  "failed", // publish failed or the running lease timed out (artifact stays locked)
  "cancelled", // unscheduled before delivery; the artifact was unlocked (terminal)
] as const;

export type PublicationOperationState =
  (typeof PUBLICATION_OPERATION_STATES)[number];

/** Terminal states admit no further delivery transition (retry re-arms `failed`
 * into a NEW pending operation-lifecycle step, not a mutation of a terminal
 * external outcome). */
export const TERMINAL_PUBLICATION_STATES: ReadonlySet<PublicationOperationState> =
  new Set(["succeeded", "cancelled"]);

// ---------------------------------------------------------------------------
// Publication intent — the immutable identity an external effect is keyed by
// ---------------------------------------------------------------------------

/** Where an operation delivers. `connector` is the delivery package; `account`
 * the connected-account/identity within it; `ref` the destination inside the
 * account (page/org/handle id) — `null` means the account's default surface. */
export type PublicationDestination = {
  connector: string;
  account: string | null;
  ref: string | null;
};

/** The STABLE identity a single external publish is keyed by — the exact bytes
 * (pinned representation revision, captured BEFORE scheduling) delivered to an
 * exact destination. The idempotency key derives from this alone, so a retry of
 * the same intent reuses the key (connector dedupes) and a partial-unique index
 * refuses a duplicate live/succeeded operation (the double-publish backstop).
 * A genuinely new publish carries a DIFFERENT revision (an edit) → a new key. */
export type PublicationExternalIdentity = {
  orgId: string;
  artifactId: string;
  pinnedRepresentationRevisionId: string;
  destination: PublicationDestination;
};

/**
 * Deterministic idempotency key for a publication intent. STABLE across
 * attempts of the same intent (the connector receives the same key on a retry
 * and dedupes → no double-publish); DISTINCT only when the published bytes or
 * the destination change (a new pinned revision from an edit, a different
 * connector/account/ref).
 *
 * NOTE the `cancellation_generation` is DELIBERATELY NOT part of the key: it is
 * the per-operation DELIVERY FENCE, not part of the external effect's identity.
 * Folding it in would defeat both connector-side retry dedupe and the
 * partial-unique double-publish backstop. Re-schedule freshness comes from a new
 * revision (an edit), not from the fence counter.
 */
export function deriveIdempotencyKey(identity: PublicationExternalIdentity): string {
  const canonical = JSON.stringify([
    identity.orgId,
    identity.artifactId,
    identity.pinnedRepresentationRevisionId,
    identity.destination.connector,
    identity.destination.account ?? null,
    identity.destination.ref ?? null,
  ]);
  return `pubop_${createHash("sha256").update(canonical).digest("hex").slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Trusted-command status effects (owned by the mutability sub-issue #1449)
// ---------------------------------------------------------------------------

/**
 * The artifact-status write a transition is allowed to trigger. The mutability
 * sub-issue (#1449) owns the trusted commands that actually flip the artifact's
 * `scheduled`/`published`/editable state; THIS ledger's transitions are the
 * ONLY thing permitted to invoke them (issue #1450: "written only via this
 * ledger's transitions"). The DB ledger routes each effect through an injected
 * `PublicationStatusPort` so this substrate never imports the sibling's
 * unmerged surface.
 *
 *   - `lock`    schedule: the artifact becomes `scheduled` and is locked to edits.
 *   - `publish` succeed: the artifact becomes `published`; the receipt is recorded.
 *   - `unlock`  cancel: the artifact returns to editable (enables edit-after-unschedule).
 *   - `none`    claim/fail/retry/reconcile: no status change (a failed publish
 *               deliberately leaves the artifact LOCKED).
 */
export type PublicationStatusEffect = "lock" | "publish" | "unlock" | "none";

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** The subset of an operation row the pure guards read. Times are epoch ms so
 * the module stays free of Date/timezone I/O; the DB layer maps `now()` and
 * `timestamptz` columns into this shape (or into the mirrored SQL predicate). */
export type PublicationOperationSnapshot = {
  state: PublicationOperationState;
  cancellationGeneration: number;
  attempt: number;
  dueAtMs: number;
  startedAtMs: number | null;
};

export type PublicationCommand =
  | { kind: "claim"; expectedGeneration: number; nowMs: number }
  | { kind: "succeed"; expectedGeneration: number }
  | { kind: "fail"; expectedGeneration: number }
  | { kind: "cancel" }
  | { kind: "retry"; maxAttempts: number }
  | { kind: "reconcileTimeout"; nowMs: number; leaseMs: number; maxAttempts: number };

export type TransitionResult =
  | {
      ok: true;
      nextState: PublicationOperationState;
      /** Increment `attempt` (a fresh delivery attempt begins). */
      bumpAttempt: boolean;
      /** Increment `cancellation_generation` (the fence advances). */
      bumpGeneration: boolean;
      statusEffect: PublicationStatusEffect;
    }
  | { ok: false; reason: string };

/**
 * Evaluate a command against a snapshot. PURE: no clock, no randomness — the
 * caller supplies `nowMs`. Returns the next state + which counters advance +
 * the trusted-command effect, or a typed refusal. The DB ledger mirrors these
 * guards into `UPDATE … WHERE <guard> RETURNING …`; a zero-row update is
 * exactly the `{ ok: false }` branch here.
 */
export function evaluateTransition(
  snap: PublicationOperationSnapshot,
  cmd: PublicationCommand,
): TransitionResult {
  switch (cmd.kind) {
    case "claim": {
      // The fence. A delivery worker dispatched for generation G may take the
      // pending→running claim ONLY if the row is still pending AND still at
      // generation G AND the operation is due. A cancel (state left `pending`)
      // or a re-schedule (generation advanced) makes this fail — the stale
      // worker publishes nothing.
      if (snap.state !== "pending") {
        return { ok: false, reason: `claim requires state 'pending', found '${snap.state}'` };
      }
      if (snap.cancellationGeneration !== cmd.expectedGeneration) {
        return {
          ok: false,
          reason: `claim fenced: expected generation ${cmd.expectedGeneration}, row at ${snap.cancellationGeneration}`,
        };
      }
      if (snap.dueAtMs > cmd.nowMs) {
        return { ok: false, reason: `claim not due until ${snap.dueAtMs} (now ${cmd.nowMs})` };
      }
      return {
        ok: true,
        nextState: "running",
        bumpAttempt: true,
        bumpGeneration: false,
        statusEffect: "none",
      };
    }
    case "succeed": {
      // Only the worker that legitimately claimed (running at the same
      // generation) may record success. A stale generation can never write a
      // success — so a fenced external effect never marks the artifact published.
      if (snap.state !== "running") {
        return { ok: false, reason: `succeed requires state 'running', found '${snap.state}'` };
      }
      if (snap.cancellationGeneration !== cmd.expectedGeneration) {
        return {
          ok: false,
          reason: `succeed fenced: expected generation ${cmd.expectedGeneration}, row at ${snap.cancellationGeneration}`,
        };
      }
      return {
        ok: true,
        nextState: "succeeded",
        bumpAttempt: false,
        bumpGeneration: false,
        statusEffect: "publish",
      };
    }
    case "fail": {
      if (snap.state !== "running") {
        return { ok: false, reason: `fail requires state 'running', found '${snap.state}'` };
      }
      if (snap.cancellationGeneration !== cmd.expectedGeneration) {
        return {
          ok: false,
          reason: `fail fenced: expected generation ${cmd.expectedGeneration}, row at ${snap.cancellationGeneration}`,
        };
      }
      // No status effect: a failed publish leaves the artifact LOCKED with the
      // operation in `failed`. Only an explicit cancel unlocks it.
      return {
        ok: true,
        nextState: "failed",
        bumpAttempt: false,
        bumpGeneration: false,
        statusEffect: "none",
      };
    }
    case "cancel": {
      // Unschedule / abandon. Wins on `pending` (unschedule before delivery) or
      // `failed` (abandon a failed publish) — NOT on `running` (past the fence;
      // a live worker reconciles after it settles) nor on a terminal
      // `succeeded`/`cancelled`. Bumps the generation so any in-flight claim for
      // the prior generation is fenced, unlocks the artifact for editing (the
      // edit-after-unschedule enabler), and frees the idempotency slot so the
      // same intent can be re-scheduled.
      if (snap.state !== "pending" && snap.state !== "failed") {
        return {
          ok: false,
          reason: `cancel requires state 'pending' or 'failed' (running reconciles; succeeded/cancelled are terminal); found '${snap.state}'`,
        };
      }
      return {
        ok: true,
        nextState: "cancelled",
        bumpAttempt: false,
        bumpGeneration: true,
        statusEffect: "unlock",
      };
    }
    case "retry": {
      // Explicit re-arm of a failed operation. Generation is UNCHANGED so the
      // same idempotency key is reused (connector dedupe) — a retry is never a
      // second external effect. Bounded by maxAttempts. The artifact stays
      // locked throughout (no status effect).
      if (snap.state !== "failed") {
        return { ok: false, reason: `retry requires state 'failed', found '${snap.state}'` };
      }
      if (snap.attempt >= cmd.maxAttempts) {
        return {
          ok: false,
          reason: `retry exhausted: attempt ${snap.attempt} >= max ${cmd.maxAttempts}`,
        };
      }
      return {
        ok: true,
        nextState: "pending",
        bumpAttempt: false,
        bumpGeneration: false,
        statusEffect: "none",
      };
    }
    case "reconcileTimeout": {
      // A running operation whose lease elapsed (worker presumed crashed).
      // Re-arm to pending if attempts remain, else settle to failed. Generation
      // is unchanged (same intent, same idempotency key). Never unlocks.
      if (snap.state !== "running") {
        return {
          ok: false,
          reason: `reconcileTimeout requires state 'running', found '${snap.state}'`,
        };
      }
      if (snap.startedAtMs == null || cmd.nowMs - snap.startedAtMs < cmd.leaseMs) {
        return { ok: false, reason: `reconcileTimeout: lease not elapsed` };
      }
      const nextState: PublicationOperationState =
        snap.attempt < cmd.maxAttempts ? "pending" : "failed";
      return {
        ok: true,
        nextState,
        bumpAttempt: false,
        bumpGeneration: false,
        statusEffect: "none",
      };
    }
    default: {
      const _exhaustive: never = cmd;
      return { ok: false, reason: `unknown command ${JSON.stringify(_exhaustive)}` };
    }
  }
}

/** The status effect a fresh schedule (row creation) triggers: always `lock`
 * (the artifact becomes `scheduled` and locked to edits). Exposed for symmetry
 * with `evaluateTransition` so the DB ledger and tests name a single source. */
export function scheduleStatusEffect(): PublicationStatusEffect {
  return "lock";
}
