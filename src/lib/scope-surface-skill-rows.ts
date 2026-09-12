/**
 * THE SKILL OWNERSHIP-SUBSET READER (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentence this module implements, verbatim:
 *
 *   "Net-new **ownership-subset readers** for artifacts and skills, keyed on
 *    the row's DURABLE ownership tuple (owner level + owner id; project via
 *    `projectId`)."
 *
 * and the sentence that keeps it off the artifact rule:
 *
 *   "Skills continue to use their native ownership tuple."
 *
 * A skill's durable ownership is the `(owner_scope, owner_id)` pair the store
 * writes, with a DB CHECK binding the two together — `owner_id IS NULL`
 * exactly when `owner_scope = 'workspace'`. There is no second locus axis, so
 * there is no precedence question here and NO project branch of the artifact
 * kind: a project-scoped skill is simply a skill whose owner scope is the
 * project.
 *
 * That last point is load-bearing. The `?scope=` filter's own projection and
 * some legacy readers map a project-level skill onto the TEAM locus as a proxy;
 * this reader does not. A proxy would file a project's skills under a team that
 * does not own them, which is exactly the falsehood a per-scope tab must not
 * tell. The native tuple is read as it is.
 *
 * ── THE TUPLE, DERIVED FROM THE RUNTIME ROW ────────────────────────────────
 *
 * The catalog hands the surfaces a projected row (`level` + `scope` +
 * `ownerUserId`), not the raw columns, so this module derives the durable pair
 * back out of it, exactly the way the store wrote it:
 *
 *   personal      → ('personal',     the skill's DURABLE `ownerUserId`)
 *   team          → ('team',         the real team id on `scope`)
 *   organization  → ('organization', the real organization id on `scope`)
 *   project       → ('project',      the real project id on `scope`)
 *   everything    → ('workspace',    NULL)
 *   else
 *
 * `ownerUserId` — not `scope` — is the personal owner, because `scope` is a
 * projection of the access policy and MOVES when a personal skill is shared,
 * while the durable owner does not.
 *
 * The last arm is the store's own: `workspace`, `agent`, `system` and a
 * third-party row are all written with `owner_scope='workspace'` and a NULL
 * owner id, so they are workspace-tier rows and the workspace union lists them.
 * A `system` row never reaches a non-admin reader in the first place — the
 * surface applies its per-row `requireResourceAccess` gate BEFORE this reader
 * runs — so this module needs no admin branch of its own and must not invent
 * one.
 *
 * `scope` carries the level's own word (`"team"`) or the generic `"org"` where
 * no concrete locus was bound; neither is an id, so neither is read as one.
 *
 * ── FAIL CLOSED, BOTH DIRECTIONS OF THE CHECK ─────────────────────────────
 *
 *   "a MALFORMED row (a non-workspace level with a missing owner id) is
 *    fail-closed and excluded from every reader, the union included."
 *
 * and its mirror image, since the CHECK is an EXACTLY-WHEN: a workspace-scope
 * row that nonetheless carries an owner id violates the same constraint and is
 * refused on the same ground. Neither shape can occur in a conforming database,
 * so neither is ever displayed as though it could be placed.
 *
 * PURE. No I/O and no `server-only`: the read is the caller's own gated
 * `listInstalledSkills` / `readSkillsCatalog`, and `WorkspaceVantage` crosses
 * as a TYPE only.
 */
import type { WorkspaceVantage } from "@/lib/scope-surface-eligibility";

/**
 * The scope a Skills tab is being read FOR — the VIEWED one, never the active
 * one. The workspace arm carries the epic's normative vantage, built by
 * #2808's exported builder and consumed here unmodified.
 */
export type SkillOwnershipLocus =
  | { readonly kind: "personal"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "workspace"; readonly vantage: WorkspaceVantage };

/**
 * As much of a catalog row as the ownership rules read. Structural on purpose:
 * the installed-skill manifest and the persisted catalog row both satisfy it,
 * and a fixture can state exactly the tuple under test and nothing else.
 */
export type SkillOwnershipRow = {
  readonly level?: string | null;
  readonly scope?: string | null;
  readonly ownerUserId?: string | null;
};

/** The durable pair, as the store wrote it. */
export type SkillOwnershipTuple = {
  readonly ownerScope: "personal" | "team" | "organization" | "project" | "workspace";
  readonly ownerId: string | null;
};

/** A present, non-blank id, or `null`. */
function presentId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The vocabulary `scope` uses when it names a LOCUS RATHER THAN AN ID: the
 * level's own word (`"team"`), the generic organization locus `"org"`, and the
 * tier words the non-owned levels project onto. None of them is an owner id,
 * and reading one as an id would bind a row to whichever locus happens to have
 * an id spelling the same word.
 */
const SCOPE_WORDS_THAT_ARE_NOT_IDS: ReadonlySet<string> = new Set([
  "personal",
  "team",
  "organization",
  "org",
  "project",
  "workspace",
  "system",
  "agent",
  "third-party",
]);

/** The CONCRETE locus id carried on `scope`, or `null`. */
function concreteScopeId(row: SkillOwnershipRow): string | null {
  const scope = presentId(row.scope);
  if (!scope) return null;
  if (scope === row.level) return null;
  if (SCOPE_WORDS_THAT_ARE_NOT_IDS.has(scope)) return null;
  return scope;
}

/**
 * The row's durable ownership tuple, or `null` when the row is fail-closed.
 *
 * Exported because it is the rule itself: a fixture pins the derivation, not
 * only its consequence for one tab.
 */
export function resolveSkillOwnershipTuple(row: SkillOwnershipRow): SkillOwnershipTuple | null {
  switch (row.level) {
    case "personal": {
      // The DURABLE owner, which sharing never moves.
      const ownerId = presentId(row.ownerUserId);
      if (!ownerId) return null;
      return { ownerScope: "personal", ownerId };
    }
    case "team": {
      const ownerId = concreteScopeId(row);
      if (!ownerId) return null;
      return { ownerScope: "team", ownerId };
    }
    case "organization": {
      const ownerId = concreteScopeId(row);
      if (!ownerId) return null;
      return { ownerScope: "organization", ownerId };
    }
    case "project": {
      // The NATIVE project locus — never the legacy team proxy.
      const ownerId = concreteScopeId(row);
      if (!ownerId) return null;
      return { ownerScope: "project", ownerId };
    }
    default: {
      // `workspace`, `agent`, `system`, a third-party row, or no level at all:
      // the store writes every one of them with a NULL owner id.
      //
      // The CHECK is an EXACTLY-WHEN, so its other direction is refused here
      // too: a workspace-tier row that names a concrete owner locus violates
      // the same constraint a missing owner id does.
      if (concreteScopeId(row) !== null) return null;
      return { ownerScope: "workspace", ownerId: null };
    }
  }
}

/** Every organization, team and project id the vantage carries. */
function vantageIds(vantage: WorkspaceVantage): {
  orgIds: Set<string>;
  teamIds: Set<string>;
  projectIds: Set<string>;
} {
  const orgIds = new Set<string>();
  const teamIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const org of vantage.organizations) {
    orgIds.add(org.orgId);
    for (const teamId of org.teamIds) teamIds.add(teamId);
    for (const projectId of org.projectIds) projectIds.add(projectId);
  }
  return { orgIds, teamIds, projectIds };
}

/** Does the workspace own this row? The union over the vantage's member
 *  organizations, plus the actor's personal scope and the workspace tier. */
function workspaceOwns(tuple: SkillOwnershipTuple, vantage: WorkspaceVantage): boolean {
  const ids = vantageIds(vantage);
  switch (tuple.ownerScope) {
    case "workspace":
      // "a schema-valid workspace-tier row (`owner_scope='workspace'`, owner id
      // NULL by CHECK) belongs to the workspace and appears in the workspace
      // union".
      return true;
    case "personal":
      return tuple.ownerId === vantage.userId;
    case "team":
      return tuple.ownerId !== null && ids.teamIds.has(tuple.ownerId);
    case "organization":
      return tuple.ownerId !== null && ids.orgIds.has(tuple.ownerId);
    case "project":
      // A project the vantage does not carry is not this workspace's to show.
      return tuple.ownerId !== null && ids.projectIds.has(tuple.ownerId);
  }
}

/** Does the viewed scope own this row? */
function scopeOwns(tuple: SkillOwnershipTuple, scope: SkillOwnershipLocus): boolean {
  switch (scope.kind) {
    case "personal":
      return tuple.ownerScope === "personal" && tuple.ownerId === scope.userId;
    case "organization":
      return tuple.ownerScope === "organization" && tuple.ownerId === scope.orgId;
    case "team":
      return tuple.ownerScope === "team" && tuple.ownerId === scope.teamId;
    case "project":
      return tuple.ownerScope === "project" && tuple.ownerId === scope.projectId;
    case "workspace":
      return workspaceOwns(tuple, scope.vantage);
  }
}

/**
 * The skills the VIEWED scope owns, in the order they arrived.
 *
 * The input is the caller's own already-authorized listing — the skills
 * surfaces apply `requireResourceAccess` per row before anything is rendered —
 * so this reader only ever NARROWS it. Ordering is the caller's, untouched.
 */
export function selectScopeOwnedSkills<Row extends SkillOwnershipRow>(
  rows: readonly Row[],
  scope: SkillOwnershipLocus,
): Row[] {
  const owned: Row[] = [];
  for (const row of rows) {
    const tuple = resolveSkillOwnershipTuple(row);
    // Fail closed: an unplaceable row is on no tab at all.
    if (!tuple) continue;
    if (!scopeOwns(tuple, scope)) continue;
    owned.push(row);
  }
  return owned;
}
