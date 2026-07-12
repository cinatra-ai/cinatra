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

import {
  applySkillLifecycleTransitionInDatabase,
  type SkillLifecycleRevisionWrite,
} from "@/lib/database";

import {
  authorizeTransition,
  buildRevisionRecord,
  INITIAL_LIFECYCLE_STATE,
  newRevisionId,
  wouldCreateSupersedeCycle,
  type LifecycleActorType,
  type LifecycleState,
  type RevisionSource,
} from "./lifecycle";

/** The minimal skill projection needed to record an upsert revision. */
export interface UpsertRevisionSkill {
  id: string;
  source?: { revision?: { value?: string | null } } | null;
  basedOnSkillIds?: readonly string[] | null;
  basedOnSkillId?: string | null;
}

/**
 * Build the atomic `lifecycleWrites` entry for a custom/personal `upsertSkill`
 * write (cinatra#1361): a distinct immutable revision (content digest = the
 * sha256 the SkillSource already computed) + the state to initialize a
 * brand-new skill to. Pure — the caller passes it to
 * replaceSkillCatalogInDatabase so it commits atomically with the content.
 */
export function buildUpsertRevisionWrite(
  skill: UpsertRevisionSkill,
  isPersonal: boolean,
  ownerUserId?: string | null,
  revisionSource?: RevisionSource,
): SkillLifecycleRevisionWrite {
  const digest =
    skill.source?.revision && typeof skill.source.revision.value === "string"
      ? skill.source.revision.value
      : null;
  const revision = buildRevisionRecord({
    skillId: skill.id,
    contentDigest: digest,
    source: revisionSource ?? "manual",
    basedOnSkillIds: skill.basedOnSkillIds ?? (skill.basedOnSkillId ? [skill.basedOnSkillId] : null),
    authorUserId: isPersonal ? (ownerUserId ?? null) : null,
  });
  return {
    skillId: revision.skillId,
    revisionId: revision.id,
    contentDigest: revision.contentDigest,
    source: revision.source,
    basedOnSkillIds: revision.basedOnSkillIds,
    baseDigests: revision.baseDigests,
    authorUserId: revision.authorUserId,
    initialState: INITIAL_LIFECYCLE_STATE,
  };
}

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
