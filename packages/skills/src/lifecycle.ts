// Skill lifecycle policy — the single authority for custom/personal skill
// lifecycle state, the legal transition graph, transition authorization,
// supersede acyclicity, and immutable-revision provenance.
//
// This is a PURE-FUNCTION leaf module: no server-only imports, no DB, no I/O
// (only node:crypto for id/digest, exactly as skill-source.ts does), so the
// DDL layer, the store write path, the migration backfill, and the fail-closed
// tests all resolve the SAME rules from one place.
//
// Scope (cinatra#1361, epic #1358): lifecycle_state applies to CUSTOM/PERSONAL
// skills only. Extension skills are DERIVED — their state comes from
// `installed_extension` via the read-time precedence matrix documented in
// docs/skills-lifecycle.md — and are NEVER a second lifecycle authority here.
// A custom/personal skill carries a non-null `lifecycle_state`; a null
// `lifecycle_state` means "derived / not a lifecycle authority".

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------

/** The four lifecycle states a custom/personal skill can hold. */
export const LIFECYCLE_STATES = ["draft", "active", "deprecated", "archived"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * The state a newly-authored custom/personal skill is initialized to. A skill
 * created through `upsertSkill` is immediately usable, so it starts `active`;
 * `draft` is a create-time state reserved for future draft-before-publish
 * flows (nothing TRANSITIONS into it — see LIFECYCLE_TRANSITIONS).
 */
export const INITIAL_LIFECYCLE_STATE: LifecycleState = "active";

// ---------------------------------------------------------------------------
// Revision provenance sources
// ---------------------------------------------------------------------------

/**
 * Where a recorded revision originated. `migration` is the backfill seed
 * source (cinatra#1361); the others are the live write paths (manual save,
 * autosave, HITL draft-update, chat-capture). Mirrored by the
 * `skill_revisions.source` CHECK constraint.
 */
export const REVISION_SOURCES = ["manual", "autosave", "hitl", "chat-capture", "migration"] as const;
export type RevisionSource = (typeof REVISION_SOURCES)[number];

export function isRevisionSource(value: unknown): value is RevisionSource {
  return typeof value === "string" && (REVISION_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Legal transition graph
// ---------------------------------------------------------------------------

/**
 * The legal lifecycle transition graph. Keys are the FROM state; values are the
 * allowed TO states.
 *
 *   draft      → active (publish) | archived (discard)
 *   active     → deprecated (wind down) | archived (retire)
 *   deprecated → active (restore / un-deprecate) | archived (retire)
 *   archived   → (terminal — nothing)
 *
 * `draft` is a CREATE-TIME state only: no state transitions INTO it. `archived`
 * is TERMINAL: no state transitions OUT of it (a resurrection is a NEW skill).
 * A same-state "transition" is not a transition and is rejected as a no-op.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze({
  draft: Object.freeze(["active", "archived"]),
  active: Object.freeze(["deprecated", "archived"]),
  deprecated: Object.freeze(["active", "archived"]),
  archived: Object.freeze([]),
}) as Readonly<Record<LifecycleState, readonly LifecycleState[]>>;

/** True iff `from → to` is a legal, non-no-op lifecycle transition. */
export function isLegalTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (!isLifecycleState(from) || !isLifecycleState(to)) return false;
  return (LIFECYCLE_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Transition authorization
// ---------------------------------------------------------------------------

/**
 * The actor classes that can drive a lifecycle transition. `user` pairs with
 * `isOwner`; org/platform admins are governance actors; `system` is the
 * migration/automation actor (e.g. the backfill's initial activation).
 */
export const LIFECYCLE_ACTOR_TYPES = ["user", "org_admin", "platform_admin", "system"] as const;
export type LifecycleActorType = (typeof LIFECYCLE_ACTOR_TYPES)[number];

export function isLifecycleActorType(value: unknown): value is LifecycleActorType {
  return typeof value === "string" && (LIFECYCLE_ACTOR_TYPES as readonly string[]).includes(value);
}

export interface TransitionAuthzInput {
  actorType: LifecycleActorType;
  /** The acting user is the owner of the skill being transitioned. */
  isOwner: boolean;
  from: LifecycleState;
  to: LifecycleState;
}

export type AuthzDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Fail-closed transition authorization. A transition is authorized only when it
 * is (a) LEGAL in the graph AND (b) the actor is entitled:
 *   - the skill OWNER may perform any legal transition on their own skill;
 *   - an org_admin / platform_admin may perform any legal transition (governance);
 *   - `system` may perform any legal transition (migration/automation);
 *   - anyone else is DENIED.
 * An unknown actor type or an illegal transition is denied.
 */
export function authorizeTransition(input: TransitionAuthzInput): AuthzDecision {
  const { actorType, isOwner, from, to } = input;
  if (!isLifecycleState(from) || !isLifecycleState(to)) {
    return { allowed: false, reason: `unknown lifecycle state in transition ${String(from)} -> ${String(to)}` };
  }
  if (!isLegalTransition(from, to)) {
    return { allowed: false, reason: `illegal lifecycle transition ${from} -> ${to}` };
  }
  if (!isLifecycleActorType(actorType)) {
    return { allowed: false, reason: `unknown actor type ${String(actorType)}` };
  }
  if (actorType === "user") {
    return isOwner
      ? { allowed: true }
      : { allowed: false, reason: "a non-owner user may not transition this skill" };
  }
  // org_admin | platform_admin | system
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Supersede acyclicity
// ---------------------------------------------------------------------------

/**
 * A `superseded_by` edge points a skill at its successor. Setting
 * `skill.superseded_by = proposedSupersededBy` must not create a cycle:
 * neither a self-edge, nor a chain that loops back to `skillId`, nor a walk
 * into a pre-existing cycle already present in the data.
 *
 * `resolveSupersededBy(id)` returns the current `superseded_by` of `id` (null /
 * undefined when it has none). The walk is bounded and fails CLOSED — a
 * pre-existing cycle or a runaway chain returns `true` (would-create-cycle) so
 * the write is rejected rather than looping.
 *
 * @returns true when the proposed edge WOULD create (or extend into) a cycle.
 */
export function wouldCreateSupersedeCycle(
  skillId: string,
  proposedSupersededBy: string,
  resolveSupersededBy: (id: string) => string | null | undefined,
  maxDepth = 10_000,
): boolean {
  if (proposedSupersededBy === skillId) return true; // self-supersede
  const seen = new Set<string>();
  let cursor: string | null | undefined = proposedSupersededBy;
  let depth = 0;
  while (cursor != null) {
    if (cursor === skillId) return true; // chain loops back to the origin
    if (seen.has(cursor)) return true; // pre-existing cycle in the data — fail closed
    seen.add(cursor);
    if (++depth > maxDepth) return true; // bounded — fail closed on a runaway chain
    cursor = resolveSupersededBy(cursor);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Revision provenance
// ---------------------------------------------------------------------------

/**
 * A fresh, distinct revision/event id. Distinct PER WRITE — repeated identical
 * content still yields a distinct revision, because provenance is per event,
 * not per content digest (cinatra#1361). NOT the content digest.
 */
export function newRevisionId(): string {
  return randomUUID();
}

export interface SkillRevisionInput {
  skillId: string;
  /** sha256 of the content at generation time, or null when unknown (legacy backfill). */
  contentDigest: string | null;
  source: RevisionSource;
  /** Skills this revision was generated FROM (agent/chat deltas), if any. */
  basedOnSkillIds?: readonly string[] | null;
  /** basedOnSkillId → that skill's content digest at generation time. */
  baseDigests?: Readonly<Record<string, string>> | null;
  authorUserId?: string | null;
  /**
   * Caller-supplied revision id for RETRY idempotency (a re-driven logical
   * write reuses its id + ON CONFLICT DO NOTHING). Omit for a fresh distinct
   * id (the common live-write case).
   */
  revisionId?: string;
}

export interface SkillRevisionRecord {
  id: string;
  skillId: string;
  contentDigest: string | null;
  source: RevisionSource;
  basedOnSkillIds: string[] | null;
  baseDigests: Record<string, string> | null;
  authorUserId: string | null;
}

/**
 * Build an immutable revision record. Throws on an invalid source (fail-closed).
 * Empty based-on / base-digest collections normalize to null.
 */
export function buildRevisionRecord(input: SkillRevisionInput): SkillRevisionRecord {
  if (!isRevisionSource(input.source)) {
    throw new Error(`invalid revision source: ${String(input.source)}`);
  }
  const basedOn = input.basedOnSkillIds && input.basedOnSkillIds.length > 0 ? [...input.basedOnSkillIds] : null;
  const baseDigests =
    input.baseDigests && Object.keys(input.baseDigests).length > 0 ? { ...input.baseDigests } : null;
  return {
    id: input.revisionId ?? newRevisionId(),
    skillId: input.skillId,
    contentDigest: input.contentDigest ?? null,
    source: input.source,
    basedOnSkillIds: basedOn,
    baseDigests,
    authorUserId: input.authorUserId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Custom/personal classification (mirrors the backfill SQL predicate)
// ---------------------------------------------------------------------------

/**
 * Whether a skill payload belongs to the custom/personal lifecycle authority —
 * the exact predicate the core__0029 backfill mirrors in SQL. Canonical marker:
 * `packageId` begins with `custom:` (every custom/personal `upsertSkill` write
 * sets it; personal → `custom:personal-skills`). The `isCustomSkill` /
 * `isPersonal` flags are additionally honored for defense in depth.
 */
export function isCustomOrPersonalSkillPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.packageId === "string" && p.packageId.startsWith("custom:")) return true;
  if (p.isCustomSkill === true || p.isPersonal === true) return true;
  return false;
}
