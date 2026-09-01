// ---------------------------------------------------------------------------
// The immutable ASSIGNMENT-SCOPE SNAPSHOT (cinatra#2813 S1, epic #2812).
//
// A run's — and an assistant thread's — applicable assignment scopes are
// decided ONCE, when it is created, and never again.
//
// WHY IT IS A SNAPSHOT AND NOT A LOOKUP. `assistant_threads.project_id` is
// MUTABLE: a person can move a thread into a different project after the fact.
// If delivery resolved assignment scope by reading that column at run time, the
// move would silently re-point a conversation at a different set of skills and
// artifacts — including ones it had never been given. The same is true of team
// membership, which changes while a long-running conversation is open. So the
// scopes are frozen at creation and the mutable column NEVER supplies
// assignment scope.
//
// WHY IT IS VERSIONED. The layers this carries will grow. A reader that met an
// unknown version and did its best with the fields it recognized would be
// guessing about authority, so an unknown version is treated as ABSENT — and
// absent has exactly one meaning, below.
//
// THE SOLE LEGACY FALLBACK. A row created before this column existed, or one
// whose payload cannot be read, resolves to the NARROWEST possible answer:
// workspace plus the instance's durable organization. Project, user and team
// layers are forbidden in fallback, because inventing any of them would hand a
// run assignments nobody made for it. Fail-closed means narrow, not empty: the
// organization floor is what every run has always had.
//
// This module is PURE — no database, no `server-only` — so the store, the
// assistant-thread writer, the delivery chain and the recommender all decide
// with the same code.
// ---------------------------------------------------------------------------

/** The only version this build writes, and the only one it reads. */
export const ASSIGNMENT_SCOPE_SNAPSHOT_VERSION = 1 as const;

export type AssignmentScopeSnapshot = {
  readonly v: typeof ASSIGNMENT_SCOPE_SNAPSHOT_VERSION;
  /** The organization the run belongs to. Always present — the scope floor. */
  readonly orgId: string;
  /** The project refinement, when the run was launched inside one. */
  readonly projectId?: string;
  /** The teams that applied at creation, SORTED and DEDUPLICATED. */
  readonly teamIds: readonly string[];
  /** The human whose act started the run; the only person a personal-scope
   *  assignment may be read for. Absent for headless runs. */
  readonly originatingHumanUserId?: string;
};

export type AssignmentScopeSnapshotRefusal =
  | "missing-organization"
  | "project-outside-organization"
  | "team-outside-organization";

export class AssignmentScopeSnapshotError extends Error {
  readonly reason: AssignmentScopeSnapshotRefusal;

  constructor(reason: AssignmentScopeSnapshotRefusal) {
    super(`assignment-scope snapshot refused: ${reason}`);
    this.name = "AssignmentScopeSnapshotError";
    this.reason = reason;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type BuildAssignmentScopeSnapshotInput = {
  orgId: string;
  projectId?: string | null;
  teamIds?: readonly string[] | null;
  originatingHumanUserId?: string | null;
  /** The organization the project belongs to, when the caller can supply it.
   *  Supplying it turns the same-organization rule ON for the project layer. */
  projectOrgId?: string | null;
  /** Organization per team id, when the caller can supply them. Supplying them
   *  turns the same-organization rule ON for the team layer. */
  teamOrgIds?: Readonly<Record<string, string>> | null;
};

/**
 * Freeze the applicable scopes.
 *
 * Team ids are sorted and deduplicated because the snapshot is compared and
 * hashed downstream: two runs with the same teams in a different order are the
 * same scope, and a payload that said otherwise would produce two answers to
 * one question.
 *
 * The same-organization checks THROW rather than dropping the offending layer.
 * A project or team from another organization at creation time is a defect in
 * the caller, and silently narrowing it would persist a scope the caller
 * believes it wrote.
 */
export function buildAssignmentScopeSnapshot(
  input: BuildAssignmentScopeSnapshotInput,
): AssignmentScopeSnapshot {
  const orgId = clean(input.orgId);
  if (!orgId) throw new AssignmentScopeSnapshotError("missing-organization");

  const projectId = clean(input.projectId) || undefined;
  if (projectId && input.projectOrgId != null && clean(input.projectOrgId) !== orgId) {
    throw new AssignmentScopeSnapshotError("project-outside-organization");
  }

  const teamIds = [
    ...new Set((input.teamIds ?? []).map((t) => clean(t)).filter((t) => t.length > 0)),
  ].sort();
  if (input.teamOrgIds) {
    for (const teamId of teamIds) {
      const owner = input.teamOrgIds[teamId];
      if (owner != null && clean(owner) !== orgId) {
        throw new AssignmentScopeSnapshotError("team-outside-organization");
      }
    }
  }

  const originatingHumanUserId = clean(input.originatingHumanUserId) || undefined;

  return Object.freeze({
    v: ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
    orgId,
    ...(projectId ? { projectId } : {}),
    teamIds: Object.freeze(teamIds),
    ...(originatingHumanUserId ? { originatingHumanUserId } : {}),
  });
}

/** The JSON text the column carries. */
export function serializeAssignmentScopeSnapshot(snapshot: AssignmentScopeSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Read a persisted payload. Returns `null` — meaning ABSENT — for anything this
 * build cannot vouch for: a missing column, unparseable text, a shape that does
 * not match, or a version it does not know.
 *
 * Accepts both the parsed object (a jsonb column) and the JSON text (a caller
 * that read it as text), because both shapes reach this function today.
 */
export function parseAssignmentScopeSnapshot(raw: unknown): AssignmentScopeSnapshot | null {
  if (raw == null) return null;

  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (record.v !== ASSIGNMENT_SCOPE_SNAPSHOT_VERSION) return null;

  const orgId = clean(record.orgId);
  if (!orgId) return null;

  if (!Array.isArray(record.teamIds)) return null;
  if (record.teamIds.some((t) => typeof t !== "string")) return null;

  // A present-but-wrong optional layer is MALFORMED, not absent. `clean()`
  // returns "" for a non-string, so without these two guards a payload
  // carrying `projectId: {}` would be reported as a perfectly good snapshot
  // with no project — `usedFallback: false` telling an auditor the payload was
  // readable while a layer silently vanished.
  if (record.projectId != null && typeof record.projectId !== "string") return null;
  if (
    record.originatingHumanUserId != null &&
    typeof record.originatingHumanUserId !== "string"
  ) {
    return null;
  }

  const projectId = clean(record.projectId) || undefined;
  const originatingHumanUserId = clean(record.originatingHumanUserId) || undefined;

  // Re-normalize on the way in: a payload written by an older build (or by
  // hand) must not be able to make two readers disagree about ordering.
  const teamIds = [...new Set((record.teamIds as string[]).map(clean).filter(Boolean))].sort();

  return Object.freeze({
    v: ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
    orgId,
    ...(projectId ? { projectId } : {}),
    teamIds: Object.freeze(teamIds),
    ...(originatingHumanUserId ? { originatingHumanUserId } : {}),
  });
}

/**
 * The SOLE legacy fallback: workspace plus the instance's durable organization.
 *
 * No project. No teams. No originating human. Every one of those would be an
 * invention, and an invented scope is an assignment nobody made.
 */
export function assignmentScopeFallback(durableOrgId: string): AssignmentScopeSnapshot {
  const orgId = clean(durableOrgId);
  if (!orgId) throw new AssignmentScopeSnapshotError("missing-organization");
  return Object.freeze({
    v: ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
    orgId,
    teamIds: Object.freeze([] as string[]),
  });
}

export type ResolvedAssignmentScope = {
  readonly snapshot: AssignmentScopeSnapshot;
  /** True when the persisted payload was absent, malformed, or an unknown
   *  version — the callers that audit scope decisions record this. */
  readonly usedFallback: boolean;
};

/**
 * THE read. Every consumer of a run's or a thread's assignment scope goes
 * through this, so "absent means the narrow fallback" is one statement rather
 * than a convention each caller re-implements.
 */
export function readAssignmentScopeSnapshot(
  raw: unknown,
  options: { durableOrgId: string },
): ResolvedAssignmentScope {
  const parsed = parseAssignmentScopeSnapshot(raw);
  if (parsed) return { snapshot: parsed, usedFallback: false };
  return { snapshot: assignmentScopeFallback(options.durableOrgId), usedFallback: true };
}

/**
 * The immutability rule, as a guard.
 *
 * The column is written once, at creation. Every update path calls this before
 * it builds its SET list, so a future writer that adds the field to an update
 * payload fails loudly here instead of quietly re-pointing a live run.
 */
export function assertAssignmentScopeSnapshotNotMutated(
  patch: Record<string, unknown>,
): void {
  if (
    Object.prototype.hasOwnProperty.call(patch, "assignmentScopeSnapshot") ||
    Object.prototype.hasOwnProperty.call(patch, "assignment_scope_snapshot")
  ) {
    throw new Error(
      "assignment_scope_snapshot is IMMUTABLE — it is decided at creation and never updated. A run whose scope can move is a run whose assignments can change under it.",
    );
  }
}
