// ---------------------------------------------------------------------------
// THE EFFECTIVE-5 DELIVERY CHAIN (cinatra#2815 S3, epic #2812).
//
// A scope-keyed assignment store answers "what did THIS scope assign". A run
// needs the other question answered: of everything assigned anywhere, WHICH
// skills does this run actually receive. The store's cap is per exact scope —
// five at project scope and five at organization scope are both legal — so
// without a second, narrower rule a run inside a project of an organization
// with teams could receive twenty-five assignments and drown the injection
// ceiling of 8 on its own.
//
// THE RULE, in one sentence: at most five DISTINCT assigned skills, taken along
// project -> user -> team(s) -> organization -> workspace, first-seen wins.
//
// WHY THAT ORDER. It is the same chain the context-slots reader already walks,
// read finest-first: the narrower the scope, the more deliberate the act of
// assigning at it, so a project's five beat the workspace's five when the
// budget runs out. Reversing it would let a workspace-wide default crowd out
// the assignment somebody made for this exact project.
//
// WHY FIRST-SEEN AND NOT LAST-SEEN. A skill assigned at two scopes is ONE
// skill; it occupies one slot, at its narrowest position. Counting it twice
// would spend the run's budget on a duplicate, and letting the coarser scope
// re-place it would move a skill a project deliberately put first.
//
// THE TEAM TIE-BREAK. Team membership is a SET with no natural priority, so
// two teams that both assign leave the order undecided — and an undecided order
// is a delivery set that differs between two dispatches of the same run. The
// snapshot's `teamIds` are sorted and deduplicated at creation, and this module
// walks them in exactly that order: ascending team id. It is arbitrary on
// purpose, and it is TOTAL, which is the property that matters.
//
// SCOPE COMES FROM THE SNAPSHOT, EXCLUSIVELY. The layers this walks are the
// ones `assignment-scope-snapshot.ts` froze at creation — never a live column,
// never the actor's current teams. An absent, malformed or unknown-version
// payload resolves through that module's SOLE legacy fallback (workspace plus
// the instance's durable organization), which is why the project, user and team
// layers cannot appear in a fallback answer: the fallback snapshot carries none
// of those fields, so there is nothing here to match them against. The rule is
// enforced by the SHAPE of the fallback value rather than by a second rule in
// this file, because two statements of one authority rule drift.
//
// This module is PURE — no database, no `server-only` — so the agent delivery
// chain, the assistant delivery seam and the recommender all decide with the
// same code.
// ---------------------------------------------------------------------------

import {
  ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
  assignmentScopeFallback,
  parseAssignmentScopeSnapshot,
  type AssignmentScopeSnapshot,
} from "./assignment-scope-snapshot";

/**
 * At most five DISTINCT assigned skills reach one run (epic #2812: "at most 5
 * distinct effective skills per run along project -> user -> team(s) ->
 * organization -> workspace, under the landed injection ceiling of 8").
 *
 * It is deliberately NOT the same constant as the store's per-scope cap even
 * though both are five today: they answer different questions, and a future
 * change to one must not silently move the other.
 */
export const EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP = 5;

/** The chain, finest scope first. The order IS the priority. */
export const EFFECTIVE_ASSIGNMENT_SCOPE_CHAIN = [
  "project",
  "user",
  "team",
  "organization",
  "workspace",
] as const;

export type EffectiveAssignmentScopeLayer =
  (typeof EFFECTIVE_ASSIGNMENT_SCOPE_CHAIN)[number];

/**
 * One stored assignment row, as this module needs it.
 *
 * STRUCTURAL on purpose (the same disposition as `RunCreationScopeActor` in the
 * snapshot module): the store's `AgentAssignedSkillRow` satisfies it, and this
 * leaf stays free of the host store's imports so the assistant seam, the agent
 * chain and a unit fixture all feed it the same way.
 *
 * `scopeKind` is OPTIONAL, and an absent one means WORKSPACE. That is not a
 * convenience: package-global assignment is exactly what the workspace tier
 * means (the store says so where it defines `WORKSPACE_ASSIGNMENT_SCOPE`), so a
 * row from a reader that carries no scope tuple is a workspace row and is
 * delivered as one. An unknown non-empty kind is a row this build cannot place,
 * and is DROPPED rather than guessed into the widest layer.
 */
export type AssignedSkillScopeRow = {
  readonly skillId: string;
  readonly scopeKind?: string | null;
  readonly scopeId?: string | null;
  readonly position?: number | null;
};

/** One delivered skill, with the layer that won it. */
export type EffectiveAssignedSkillPick = {
  readonly skillId: string;
  readonly layer: EffectiveAssignmentScopeLayer;
  /** The exact scope id the winning row carried; "" for the workspace layer. */
  readonly scopeId: string;
};

export type EffectiveAssignedSkillsSelection = {
  /** The delivered ids, in chain order. At most the per-run cap. */
  readonly skillIds: string[];
  /** The same ids with their winning layer — for the audit line. */
  readonly picks: EffectiveAssignedSkillPick[];
  /** Distinct ids the chain reached but the cap refused, in chain order. */
  readonly droppedOverCap: string[];
  /** Rows whose `scopeKind` this build cannot place. Fail-closed, never widened. */
  readonly unplaceableScopeKinds: string[];
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The id(s) one layer matches for this snapshot, in delivery order. */
function layerTargets(
  layer: EffectiveAssignmentScopeLayer,
  snapshot: AssignmentScopeSnapshot,
): string[] {
  switch (layer) {
    case "project": {
      const id = clean(snapshot.projectId);
      return id ? [id] : [];
    }
    case "user": {
      // The personal layer belongs to a PERSON. A headless run carries no
      // originating human, so it has no personal layer at all — reading one
      // for it would deliver an assignment nobody made for that run.
      const id = clean(snapshot.originatingHumanUserId);
      return id ? [id] : [];
    }
    case "team":
      // Sorted at creation AND re-sorted here: a payload written by hand must
      // not be able to make two readers disagree about delivery order.
      return [...new Set((snapshot.teamIds ?? []).map(clean).filter(Boolean))].sort();
    case "organization": {
      const id = clean(snapshot.orgId);
      return id ? [id] : [];
    }
    case "workspace":
      // The workspace has no id to point at. Matching it by KIND (rather than
      // against the store's sentinel) keeps this pure leaf free of the host
      // module that owns the sentinel, and the store's CHECK constraint already
      // guarantees a workspace row carries nothing else.
      return [""];
  }
}

const PLACEABLE = new Set<string>(EFFECTIVE_ASSIGNMENT_SCOPE_CHAIN);

/**
 * Select the effective set for ONE already-resolved snapshot.
 *
 * A pure function of its two inputs: the same rows and the same snapshot always
 * produce the same ordered answer, which is what makes a run's delivered set
 * reproducible across dispatches.
 */
export function selectEffectiveAssignedSkills(
  rows: readonly AssignedSkillScopeRow[] | null | undefined,
  snapshot: AssignmentScopeSnapshot,
  options: { cap?: number } = {},
): EffectiveAssignedSkillsSelection {
  const cap = Math.max(0, options.cap ?? EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP);

  type Indexed = { row: AssignedSkillScopeRow; index: number; skillId: string };
  const byLayer = new Map<string, Indexed[]>();
  const unplaceable = new Set<string>();

  (rows ?? []).forEach((row, index) => {
    const skillId = clean(row?.skillId);
    if (skillId === "") return;
    const rawKind = clean(row?.scopeKind);
    // Absent tuple => workspace (see `AssignedSkillScopeRow`).
    const kind = rawKind === "" ? "workspace" : rawKind;
    if (!PLACEABLE.has(kind)) {
      unplaceable.add(kind);
      return;
    }
    const scopeId = kind === "workspace" ? "" : clean(row?.scopeId);
    const key = `${kind} ${scopeId}`;
    const bucket = byLayer.get(key) ?? [];
    bucket.push({ row, index, skillId });
    byLayer.set(key, bucket);
  });

  // Within one exact scope the stored `position` is the order the settings page
  // wrote. A row with no position keeps its input order, and the total-order
  // tie-break is the input index then the id, so the sort can never be the
  // reason two dispatches differ.
  const ordered = (bucket: Indexed[]): Indexed[] =>
    [...bucket].sort((a, b) => {
      const pa = typeof a.row.position === "number" ? a.row.position : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.row.position === "number" ? b.row.position : Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      if (a.index !== b.index) return a.index - b.index;
      return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
    });

  const seen = new Set<string>();
  const picks: EffectiveAssignedSkillPick[] = [];
  const droppedOverCap: string[] = [];

  for (const layer of EFFECTIVE_ASSIGNMENT_SCOPE_CHAIN) {
    for (const target of layerTargets(layer, snapshot)) {
      const bucket = byLayer.get(`${layer} ${target}`);
      if (!bucket) continue;
      for (const entry of ordered(bucket)) {
        if (seen.has(entry.skillId)) continue;
        seen.add(entry.skillId);
        if (picks.length >= cap) {
          droppedOverCap.push(entry.skillId);
          continue;
        }
        picks.push({ skillId: entry.skillId, layer, scopeId: target });
      }
    }
  }

  return {
    skillIds: picks.map((p) => p.skillId),
    picks,
    droppedOverCap,
    unplaceableScopeKinds: [...unplaceable].sort(),
  };
}

/** Why a resolution could not even build the legacy fallback. */
export type EffectiveAssignedSkillsFallbackDegradation =
  /** No valid snapshot AND no durable organization to fall back to. */
  "no-durable-organization";

export type EffectiveAssignedSkillsResolution = EffectiveAssignedSkillsSelection & {
  /** The snapshot the chain actually walked. */
  readonly snapshot: AssignmentScopeSnapshot;
  /** True when the persisted payload was absent, malformed, or an unknown version. */
  readonly usedFallback: boolean;
  /** Non-null only when the fallback itself had to be narrowed. */
  readonly fallbackDegraded: EffectiveAssignedSkillsFallbackDegradation | null;
};

/**
 * The chain's ENTRY POINT: a persisted payload plus the rows, in one call.
 *
 * The snapshot is parsed by the module that owns the payload — this one never
 * re-implements the version rule, and therefore cannot disagree with it about
 * what "absent" means.
 *
 * When the payload is unusable AND the caller cannot name the instance's
 * durable organization, the answer is narrowed once more, to the WORKSPACE
 * layer alone. That is strictly narrower than the legacy fallback, never wider:
 * an organization id this build cannot vouch for would be an invention, and the
 * degradation is REPORTED (`fallbackDegraded`) rather than hidden, because a
 * run silently losing its organization layer is a fact an operator must be able
 * to read.
 */
export function resolveEffectiveAssignedSkills(
  rows: readonly AssignedSkillScopeRow[] | null | undefined,
  options: {
    /** The raw persisted payload (jsonb object or JSON text), or nothing. */
    snapshot?: unknown;
    /** The instance's durable organization — the legacy fallback's org floor. */
    durableOrgId?: string | null;
    cap?: number;
  },
): EffectiveAssignedSkillsResolution {
  const parsed = parseAssignmentScopeSnapshot(options.snapshot);
  if (parsed) {
    return {
      ...selectEffectiveAssignedSkills(rows, parsed, { cap: options.cap }),
      snapshot: parsed,
      usedFallback: false,
      fallbackDegraded: null,
    };
  }

  const durableOrgId = clean(options.durableOrgId);
  if (durableOrgId) {
    const snapshot = assignmentScopeFallback(durableOrgId);
    return {
      ...selectEffectiveAssignedSkills(rows, snapshot, { cap: options.cap }),
      snapshot,
      usedFallback: true,
      fallbackDegraded: null,
    };
  }

  const workspaceOnly: AssignmentScopeSnapshot = Object.freeze({
    v: ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
    // Empty on purpose: `layerTargets` skips a layer with no target id, so an
    // unnameable organization contributes NO organization layer instead of a
    // wrong one.
    orgId: "",
    teamIds: Object.freeze([] as string[]),
  });
  return {
    ...selectEffectiveAssignedSkills(rows, workspaceOnly, { cap: options.cap }),
    snapshot: workspaceOnly,
    usedFallback: true,
    fallbackDegraded: "no-durable-organization",
  };
}
