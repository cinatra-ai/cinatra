// SkillSource — the content-source descriptor for a catalog skill.
//
// `cinatra.skills` stays the unified catalog. Historically a skill's content
// location was its absolute `sourcePath` (a path inside the `data/skills` tree),
// treated as permanent truth. The generalized content store makes
// that path one resolution outcome among several: extension skills resolve to an
// immutable digest snapshot; non-extension skills to a mutable active-head
// revision in the same store. `SkillSource` is the descriptor every content
// reader will resolve through; `sourcePath` remains a legacy fallback locator.
//
// This is a pure-function leaf module — no server-only imports — so it stays
// unit-testable in isolation (same contract the package-source dispatcher keeps).

import { createHash, randomUUID } from "node:crypto";

// The skill lifecycle policy is co-located here (see the "Skill lifecycle
// policy" section at the foot of this module). It is the SAME pure-leaf
// authority skill-source already is (node:crypto only, no server/DB import), so
// the DDL layer, the store write path, the migration backfill, and the
// fail-closed tests all resolve one set of rules from one already-reachable
// module — the type-only import below is fully erased at compile time, so this
// leaf stays server-free in the route graph.
import type { SkillLifecycleRevisionWrite } from "@/lib/database";

/** Where a skill's content originates. */
export type SkillSourceOrigin =
  | "extension" // bundled/installed extension package skill (immutable snapshot once recorded)
  | "github" // end-user GitHub-installed skill package
  | "vendored" // Verdaccio/registry-published package (e.g. @anthropics/skills)
  | "custom" // LLM-generated personal/agent delta skill
  | "local"; // a bare on-disk skill with no package identity

/**
 * Revision discriminator. Extension skills are immutable digest snapshots;
 * non-extension skills track a mutable active-head revision. A digest is only
 * present once a source has been explicitly recorded; a derived
 * descriptor (legacy rows with no stored source) is always active-head.
 */
export type SkillSourceRevision =
  | { kind: "digest"; value: string }
  | { kind: "activeHead"; value: string | null };

/**
 * The `{origin, scope, package-ref, digest-or-activeRevision, relativePath}`
 * descriptor. Persisted inside the skill row payload JSON (the `skills` table is
 * `{id, payload}` — no dedicated columns), so adding it is purely additive.
 */
export interface SkillSource {
  origin: SkillSourceOrigin;
  /** Ownership-scope projection (SkillLevel-compatible string), or null. */
  scope: string | null;
  /** Package id / ref for packaged origins; null for purely local/custom skills. */
  packageRef: string | null;
  /** Immutable digest (extension) or mutable active-head revision (non-extension). */
  revision: SkillSourceRevision;
  /** SKILL.md path relative to the package/checkout root, or null when unknown. */
  relativePath: string | null;
}

/**
 * Minimal projection `resolveSkillSource` derives a descriptor from. `PersistedSkill`
 * structurally satisfies this, so the resolver accepts a skill row directly without
 * coupling this leaf module to the server-only store types.
 */
export interface SkillSourceResolvable {
  packageId?: string;
  packageName?: string;
  packageSlug?: string;
  sourcePath?: string;
  sourceUrl?: string;
  originRepo?: string;
  scope?: string;
  isCustom?: boolean;
  isCustomSkill?: boolean;
  /** An explicitly-recorded source (set by later slices / migration); wins over derivation. */
  source?: SkillSource | null;
}

const SKILL_SOURCE_ORIGINS: readonly SkillSourceOrigin[] = [
  "extension",
  "github",
  "vendored",
  "custom",
  "local",
];

/** Runtime guard used when reading a stored payload back into a SkillSource. */
export function isSkillSource(value: unknown): value is SkillSource {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!SKILL_SOURCE_ORIGINS.includes(v.origin as SkillSourceOrigin)) return false;
  if (!(typeof v.scope === "string" || v.scope === null)) return false;
  if (!(typeof v.packageRef === "string" || v.packageRef === null)) return false;
  if (!(typeof v.relativePath === "string" || v.relativePath === null)) return false;
  const rev = v.revision as Record<string, unknown> | undefined;
  if (typeof rev !== "object" || rev === null) return false;
  if (rev.kind === "digest") return typeof rev.value === "string";
  if (rev.kind === "activeHead") return typeof rev.value === "string" || rev.value === null;
  return false;
}

function deriveOrigin(skill: SkillSourceResolvable): SkillSourceOrigin {
  if (skill.isCustomSkill) return "custom";
  const packageId = skill.packageId ?? "";
  if (packageId.startsWith("github:")) return "github";
  if (packageId.startsWith("verdaccio:")) return "vendored";
  // Non-personal user-authored custom skills
  // (team / organization / project scope via upsertCustomSkill or
  // createSkillFromTemplate) are written by `upsertSkill` with
  // packageId = `custom:${packageSlug}` but WITHOUT `isCustomSkill: true`
  // (that flag is reserved for the personal/agent LLM-delta path). Without
  // the "custom:" prefix check, they would be mapped to "extension", so the
  // extension → digest promotion would
  // have mis-tagged user-mutable scoped skills as immutable digest snapshots.
  if (packageId.startsWith("custom:")) return "custom";
  if (skill.originRepo || (skill.sourceUrl && /github\.com/i.test(skill.sourceUrl))) {
    return "github";
  }
  if (packageId || skill.packageName) return "extension";
  return "local";
}

/**
 * Resolve a skill row to its content-source descriptor.
 *
 * An explicitly-recorded `source` always wins. Otherwise a best-effort
 * descriptor is derived from the legacy fields: the origin is classified from
 * the package identity, and the revision is `activeHead` (a derived row carries
 * no immutable digest until one is recorded). `relativePath` is
 * left null for derived rows — content readers fall back to the legacy
 * `sourcePath` until the cutover computes precise relative paths.
 *
 * Returns null only for a row with no usable identity at all.
 */
export function resolveSkillSource(skill: SkillSourceResolvable): SkillSource | null {
  if (skill.source && isSkillSource(skill.source)) return skill.source;
  if (
    !skill.packageId &&
    !skill.packageName &&
    !skill.sourcePath &&
    !skill.isCustomSkill &&
    !skill.originRepo &&
    !skill.sourceUrl
  ) {
    return null;
  }
  return {
    origin: deriveOrigin(skill),
    scope: skill.scope ?? null,
    packageRef: skill.packageId ?? null,
    revision: { kind: "activeHead", value: null },
    relativePath: null,
  };
}

// ---------------------------------------------------------------------------
// Generalized content-store write-side helpers.
//
// `source` is populated on every catalog write via `upsertSkill` so the
// SkillSource descriptor is no longer a derive-on-read approximation — every
// new/updated row carries a real revision (the active-head pointer = sha256 of
// its current content) and (for non-extension skills) a stable relativePath.
// The on-disk write into `data/skills` is unchanged (the legacy mirror stays
// canonical for now); only the row metadata grows the source field.
//
// Extension skills (registerExtensionSkill → upsertSkill) inherit the same
// active-head default; they are later promoted to immutable digest
// revisions once the digest is recorded against the package snapshot.
// ---------------------------------------------------------------------------

/**
 * Compute the SkillSource active-head revision value for a row being written:
 * a full-content sha256 hex digest of `content`. Distinct from the
 * `llm-matching/hashes` `computeSkillContentDigest`, which truncates to 16 KiB
 * for matching-cache stability — that semantic is wrong for revision identity
 * (any byte change anywhere in `content` MUST flip the revision).
 *
 * An empty `content` still produces a deterministic digest (the empty-string
 * sha256), never `null` — `revision.value === null` means "no digest known
 * yet" (derived row from a legacy read), distinct from "content hashes empty".
 */
export function computeSkillSourceRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Inputs the write-side `buildSkillSourceForWrite` derives a SkillSource from.
 * A superset of `SkillSourceResolvable` that ALSO carries the current content
 * (for the digest) and an optional `relativePath` (defaulting to `"SKILL.md"`,
 * the conventional layout where the markdown lives at the skill-dir root).
 */
export interface SkillSourceWriteInput extends SkillSourceResolvable {
  content: string;
  /** SKILL.md path relative to the package/checkout root. Defaults to "SKILL.md". */
  relativePath?: string;
}

/**
 * Build the SkillSource descriptor for a row being written. Reuses
 * `resolveSkillSource`'s origin/scope/packageRef classification, then refines:
 *
 * - `revision`: `origin === "extension"` ⇒ `digest` (immutable
 *   snapshot semantics for extension-bundled skills, including agent-bundled
 *   skills registered via `registerPackageAgentSkill`). Every other origin
 *   (custom, github, vendored, local) keeps the `activeHead` default. Either
 *   way, the value is the full-content sha256 from `computeSkillSourceRevision`.
 *   The TAG distinguishes "this revision is the canonical immutable snapshot"
 *   from "this is the currently-mutable head".
 * - `relativePath`: defaults to `"SKILL.md"` (the conventional skill-dir layout
 *   where every skill has its markdown at the dir root). Callers can override.
 *
 * Returns null only when the row has no usable identity at all — same contract
 * as the read-side resolver — so callers can fall back to legacy `sourcePath`.
 */
export function buildSkillSourceForWrite(input: SkillSourceWriteInput): SkillSource | null {
  const derived = resolveSkillSource(input);
  if (!derived) return null;
  const revisionKind: SkillSourceRevision["kind"] =
    derived.origin === "extension" ? "digest" : "activeHead";
  const revisionValue = computeSkillSourceRevision(input.content);
  return {
    ...derived,
    revision: { kind: revisionKind, value: revisionValue } as SkillSourceRevision,
    relativePath: input.relativePath ?? "SKILL.md",
  };
}

// ===========================================================================
// Skill lifecycle policy — the single authority for custom/personal skill
// lifecycle state, the legal transition graph, transition authorization,
// supersede acyclicity, and immutable-revision provenance.
//
// Co-located in this pure-function leaf module (no server-only imports, no DB,
// no I/O — only node:crypto for id/digest) so the DDL layer, the store write
// path, the migration backfill, and the fail-closed tests all resolve the SAME
// rules from one already route-reachable place. (Physically merged from the
// former sibling `lifecycle.ts` leaf so the store write path reaches these
// pure rules through a module it already imports — no net-new reachable
// first-party leaf on the hub routes. The transition MECHANISM that writes to
// the DB lives in `lifecycle-store.ts`, which stays a server module reached
// only by its callers/tests.)
//
// Scope (cinatra#1361, epic #1358): lifecycle_state applies to CUSTOM/PERSONAL
// skills only. Extension skills are DERIVED — their state comes from
// `installed_extension` via the read-time precedence matrix documented in
// docs/internals/architecture/skills-lifecycle.md — and are NEVER a second lifecycle authority here.
// A custom/personal skill carries a non-null `lifecycle_state`; a null
// `lifecycle_state` means "derived / not a lifecycle authority".
// ===========================================================================

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
 * autosave, HITL draft-update, chat-capture). `rollback` (cinatra#1362) is a
 * restore write — a NEW revision that re-points the active head at a prior
 * revision's exact content (never a mutation of history). Mirrored by the
 * `skill_revisions.source` CHECK constraint (a drift test asserts the CHECK
 * enumerates EXACTLY this set).
 */
export const REVISION_SOURCES = ["manual", "autosave", "hitl", "chat-capture", "migration", "rollback"] as const;
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
// Consumer-side runtime-delivery enforcement (A3, cinatra#1363)
// ---------------------------------------------------------------------------

/**
 * The SINGLE authority for whether a skill's `lifecycle_state` permits RUNTIME
 * DELIVERY to a consumer — tier resolution (`getAssignedSkillIdsForAgent`),
 * provider delivery (llm-bridge personal delta + explicit skill paths), MCP
 * direct reads, matching candidacy, and default listings. Fail-closed by
 * construction; every consumer resolves this ONE predicate so the matrix is
 * enforced identically everywhere.
 *
 *   null         → true  — DERIVED (extension / legacy / bare-local): NOT a
 *                          lifecycle authority here. The extension install-state
 *                          is the single authority (read-time precedence), so
 *                          this custom/personal gate is a pass-through and never
 *                          becomes a second authority (docs/internals/architecture/skills-lifecycle.md).
 *   'active'     → true
 *   'deprecated' → true  — still delivered (badging is display-only, not gating)
 *   'draft'      → false — owner-visible only; never runtime-delivered
 *   'archived'   → false — retired; excluded from runtime delivery + default lists
 *   anything else (an unknown non-null value the CHECK could never store, or
 *                `undefined` = the state could not be resolved / a reader error)
 *              → false — FAIL-CLOSED (unknown state = not delivered)
 *
 * `null` (a resolved DB NULL = derived) is the ONLY nullish value that delivers.
 * `undefined` (state absent / unresolved) fails closed — a caller that cannot
 * resolve a state MUST pass `undefined`, never `null`, so a missing lifecycle
 * read can never be mistaken for "derived".
 */
export function isRuntimeDeliverableLifecycleState(state: string | null | undefined): boolean {
  if (state === null) return true; // derived — not gated by this layer
  if (state === undefined) return false; // unresolved → fail-closed
  return state === "active" || state === "deprecated";
}

/**
 * The state × consumer enforcement matrix (cinatra#1363), pinned by a test so
 * every cell is a deliberate, reviewed decision (acceptance criterion: "a
 * state-x-consumer matrix in-repo; each cell covered by a test"). Rows are every
 * `lifecycle_state` a custom/personal skill can carry, plus `null`
 * (derived/extension) and `unknown` (the fail-closed guard for any value the DB
 * CHECK could never store). Columns are the consumer axes.
 *
 * Decisions: `deliver`/`include`/`sync`/`list` = the skill flows to that
 * consumer; `exclude` = it does not; `reclaim` = its remote Anthropic mirror is
 * actively marked stale so the existing GC path deletes it; `owner-only` =
 * visible only to the authoring owner's direct reads; `manage-only` = visible
 * only to actors holding `manage` (management-plane restore/rollback/history);
 * `visible` = the management-plane always sees the row.
 *
 * The delivery columns (`matching`, `tierResolution`, `providerDelivery`,
 * `anthropicMirror`) MUST agree with `isRuntimeDeliverableLifecycleState` — the
 * pin test asserts that equivalence, so the matrix and the predicate can never
 * silently diverge.
 */
export const SKILL_LIFECYCLE_CONSUMER_MATRIX = Object.freeze({
  draft:      Object.freeze({ matching: "exclude", tierResolution: "exclude", providerDelivery: "exclude", directDefaultList: "owner-only",  managementPlane: "visible", anthropicMirror: "exclude" }),
  active:     Object.freeze({ matching: "include", tierResolution: "deliver", providerDelivery: "deliver", directDefaultList: "list",        managementPlane: "visible", anthropicMirror: "sync" }),
  deprecated: Object.freeze({ matching: "include", tierResolution: "deliver", providerDelivery: "deliver", directDefaultList: "list",        managementPlane: "visible", anthropicMirror: "sync" }),
  archived:   Object.freeze({ matching: "exclude", tierResolution: "exclude", providerDelivery: "exclude", directDefaultList: "manage-only", managementPlane: "visible", anthropicMirror: "reclaim" }),
  null:       Object.freeze({ matching: "include", tierResolution: "deliver", providerDelivery: "deliver", directDefaultList: "list",        managementPlane: "visible", anthropicMirror: "sync" }),
  unknown:    Object.freeze({ matching: "exclude", tierResolution: "exclude", providerDelivery: "exclude", directDefaultList: "exclude",     managementPlane: "visible", anthropicMirror: "exclude" }),
} as const);

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
   * The prior revision whose exact content this write RESTORES (cinatra#1362).
   * Set on — and ONLY on — a `rollback` revision (the pure mirror of the DB
   * `skill_revisions_rollback_provenance_check`: rollback ⇔ restoresRevisionId).
   */
  restoresRevisionId?: string | null;
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
  /** Non-null iff `source === "rollback"` — the restored revision (cinatra#1362). */
  restoresRevisionId: string | null;
}

/**
 * Build an immutable revision record. Throws on an invalid source (fail-closed)
 * and enforces the rollback-provenance biconditional: `restoresRevisionId` is
 * set iff `source === "rollback"` (the pure mirror of the DB CHECK). Empty
 * based-on / base-digest collections normalize to null.
 */
export function buildRevisionRecord(input: SkillRevisionInput): SkillRevisionRecord {
  if (!isRevisionSource(input.source)) {
    throw new Error(`invalid revision source: ${String(input.source)}`);
  }
  const restoresRevisionId = input.restoresRevisionId ?? null;
  const isRollback = input.source === "rollback";
  if (isRollback !== (restoresRevisionId != null)) {
    throw new Error(
      `rollback provenance mismatch: source=${input.source} restoresRevisionId=${String(restoresRevisionId)} — a rollback revision MUST carry restoresRevisionId and only a rollback revision may`,
    );
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
    restoresRevisionId,
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

// ---------------------------------------------------------------------------
// Upsert-revision write builder (the pure part of the store write path)
// ---------------------------------------------------------------------------

/** The minimal skill projection needed to record an upsert revision. */
export interface UpsertRevisionSkill {
  id: string;
  source?: { revision?: { value?: string | null } } | null;
  basedOnSkillIds?: readonly string[] | null;
  basedOnSkillId?: string | null;
  /**
   * The SKILL.md body being written (cinatra#1362 content authority). Carried
   * so the write path durably stores the content blob keyed by its digest — the
   * authoritative content the active revision resolves to. When present it MUST
   * hash to `source.revision.value` (the DB blob-integrity CHECK enforces it).
   */
  content?: string | null;
}

/**
 * Build the atomic `lifecycleWrites` entry for a custom/personal `upsertSkill`
 * write (cinatra#1361): a distinct immutable revision (content digest = the
 * sha256 the SkillSource already computed) + the state to initialize a
 * brand-new skill to + the content blob to store (cinatra#1362). Pure — the
 * caller passes it to replaceSkillCatalogInDatabase so it commits atomically
 * with the content. The `SkillLifecycleRevisionWrite` return type is a
 * compile-time-only import, so this builder stays a pure leaf (no server module
 * pulled into the graph).
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
    restoresRevisionId: revision.restoresRevisionId,
    // Content authority (cinatra#1362): store the blob whenever we have both the
    // content and its digest. When they disagree the DB CHECK aborts the write
    // (fail-closed) — a revision can never claim a digest it did not hash to.
    content: typeof skill.content === "string" && digest != null ? skill.content : null,
    // Bundle-aware content authority (cinatra#2088, epic #2086 S1): an authored/
    // chat-captured skill becomes a BUNDLE OF ONE — the SKILL.md router — so it
    // enters the same revision-file manifest + content-addressed blob authority
    // as a multi-file package skill and can grow references later (closing the
    // "custom skills can never carry references" gap). The router's per-file
    // digest is sha256(utf8 content) — the SAME value as `computeSkillSourceRevision`,
    // so the manifest agrees with the source revision digest by construction.
    bundleFiles:
      typeof skill.content === "string" && digest != null
        ? [{ path: "SKILL.md", bytes: Buffer.from(skill.content, "utf8"), isRouter: true }]
        : null,
    initialState: INITIAL_LIFECYCLE_STATE,
  };
}
