// Policy-enforcing lifecycle transition for custom/personal skills
// (cinatra#1361 AC3). Wraps the atomic DB compare-and-swap primitive
// (applySkillLifecycleTransitionInDatabase) behind the pure lifecycle policy: a
// transition is applied only when it is LEGAL, AUTHORIZED, and — for a supersede
// edge — ACYCLIC. The DB write swaps on the caller-observed current state and
// writes the audit row atomically iff the swap matched, so a concurrent
// transition is a fail-closed no-op rather than a mis-audited state.
//
// This is the transition MECHANISM the later lifecycle slices (transition UI /
// API) call; A1 ships it wired to the pure policy + the audited DB primitive.
// It is a SERVER module (it imports @/lib/database), reached only by those
// callers and its tests — NOT by the `upsertSkill` write path, whose pure
// revision builder lives in the already-reachable `skill-source` leaf. The pure
// policy it enforces is the single authority co-located in `skill-source.ts`.

import { applySkillLifecycleTransitionInDatabase } from "@/lib/database";

import {
  authorizeTransition,
  newRevisionId,
  wouldCreateSupersedeCycle,
  type LifecycleActorType,
  type LifecycleState,
} from "./skill-source";

export interface TransitionSkillLifecycleInput {
  skillId: string;
  /** The caller-observed current state — the compare-and-swap guard. */
  from: LifecycleState;
  to: LifecycleState;
  actor: { type: LifecycleActorType; isOwner: boolean; userId?: string | null };
  reason?: string | null;
  /** Set to record a supersede edge alongside a deprecate/archive transition. */
  supersededBy?: string | null;
  /**
   * Resolves a skill's current `superseded_by` (null/undefined when none) — the
   * no-cycle walk. Required whenever `supersededBy` is set.
   */
  resolveSupersededBy?: (id: string) => string | null | undefined;
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

/**
 * Apply a lifecycle transition, fail-closed. Order: authorize (legal +
 * entitled) → no-cycle (when superseding) → atomic CAS + audit. Returns
 * `{ ok: false }` with a reason on any gate failure or a concurrent state move.
 */
export function transitionSkillLifecycle(input: TransitionSkillLifecycleInput): TransitionResult {
  const authz = authorizeTransition({
    actorType: input.actor.type,
    isOwner: input.actor.isOwner,
    from: input.from,
    to: input.to,
  });
  if (!authz.allowed) return { ok: false, reason: authz.reason };

  if (input.supersededBy != null) {
    const resolve = input.resolveSupersededBy ?? (() => null);
    if (wouldCreateSupersedeCycle(input.skillId, input.supersededBy, resolve)) {
      return {
        ok: false,
        reason: `supersede ${input.skillId} -> ${input.supersededBy} would create a cycle`,
      };
    }
  }

  const { changed } = applySkillLifecycleTransitionInDatabase({
    skillId: input.skillId,
    expectedFrom: input.from,
    to: input.to,
    supersededBy: input.supersededBy ?? null,
    auditId: newRevisionId(),
    actorUserId: input.actor.userId ?? null,
    actorType: input.actor.type,
    reason: input.reason ?? null,
  });

  return changed
    ? { ok: true }
    : { ok: false, reason: "lifecycle state changed concurrently — transition not applied" };
}
