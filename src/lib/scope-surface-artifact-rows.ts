/**
 * THE ARTIFACT OWNERSHIP-SUBSET READER (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentence this module implements, verbatim:
 *
 *   "Net-new **ownership-subset readers** for artifacts and skills, keyed on
 *    the row's DURABLE ownership tuple (owner level + owner id; project via
 *    `projectId`)."
 *
 * A scope's Artifacts tab answers a different question from `/artifacts`. The
 * global library lists the ACTOR's own artifacts and then lets the reader
 * narrow that set with the `?scope=` filter; a scope tab lists exactly what
 * THIS scope OWNS. Those are not the same set and they are not reached the same
 * way:
 *
 *   "ownership is read from the durable tuple; … Not the `?scope=` filter — a
 *    source-level read."
 *
 * So this module never imports `@/lib/scope-filter`, in any form. That filter's
 * grammar (`personal|workspace|admin|team:<id>|org:<id>|project:<id>`) cannot
 * express an ownership subset at all — its `workspace` token is the DEFAULT and
 * collapses any selection to the broadest view — and its predicate answers
 * "does this row's footprint intersect the selection", which is a superset
 * question. Ownership is answered here, off the row's own columns.
 *
 * ── THE PROJECT CLASSIFICATION RULE (bound BEFORE implementation) ──────────
 *
 *   "for artifact ownership tabs, a non-null `projectId` is the row's EXCLUSIVE
 *    displayed locus and takes precedence over `ownerLevel`; only rows with
 *    `projectId IS NULL` are classified by `ownerLevel`/`ownerId`. Empty,
 *    unresolved, cross-org, or unauthorized project ids fail closed."
 *
 * An artifact row carries `ownerLevel`/`ownerId` AND a separate `projectId`
 * axis, so a single row can name two loci at once. Displaying it on both tabs
 * would double-count it and would make neither tab's list true, so the rule
 * picks ONE: the project. That is the narrower, more specific locus, and it is
 * the one a reader looking at a project expects to be complete.
 *
 * EXCLUSIVE means exclusive in both directions — a project-bearing row is on
 * the project tab and on NO other ownership tab, its `ownerLevel`
 * notwithstanding. That is what makes "appears exactly once" true.
 *
 * ── FAIL CLOSED ───────────────────────────────────────────────────────────
 *
 * Three shapes are refused outright, from EVERY reader including the workspace
 * union:
 *
 *   - an EMPTY or whitespace-only `projectId` — a project locus that names no
 *     project. It is not "no project" (that is `null`); it is a broken one, and
 *     a broken locus is never resolved to the fallback `ownerLevel` axis,
 *     because that would display the row somewhere it does not belong.
 *   - a MALFORMED ownership tuple: a non-workspace `ownerLevel` with a missing
 *     owner id, per the epic's own words — "a MALFORMED row (a non-workspace
 *     level with a missing owner id) is fail-closed and excluded from every
 *     reader, the union included."
 *   - in the workspace union, an UNRESOLVED / CROSS-ORG / UNAUTHORIZED locus:
 *     the `WorkspaceVantage` is the authorization, so a project, team or
 *     organization the vantage does not carry is absent. The vantage holds only
 *     what this actor may see, so "not in the vantage" and "not authorized here"
 *     are the same fact.
 *
 * PURE, and free of any I/O or `server-only`: the read is the caller's (the
 * route's own gated `listArtifacts`), and the RULES are here, where a fixture
 * can drive every one of them. `ArtifactSummary` and `WorkspaceVantage` cross
 * the boundary as TYPES only, so this module adds no route-graph weight.
 */
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { WorkspaceVantage } from "@/lib/scope-surface-eligibility";

/**
 * The scope an Artifacts tab is being read FOR — the VIEWED one, never the
 * active one.
 *
 * Each arm carries the id the durable tuple is compared against, so the reader
 * needs no session and no second read of its own. The workspace arm carries the
 * epic's normative vantage, built by #2808's exported builder and consumed here
 * unmodified.
 */
export type ArtifactOwnershipLocus =
  | { readonly kind: "personal"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "workspace"; readonly vantage: WorkspaceVantage };

/** The ONE locus a row is displayed at, after the project rule has run. */
type ResolvedArtifactLocus =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "user"; readonly ownerId: string }
  | { readonly kind: "team"; readonly ownerId: string }
  | { readonly kind: "organization"; readonly ownerId: string }
  | { readonly kind: "workspace" };

/** A present, non-blank id, or `null`. A blank id is a BROKEN locus, not an
 *  absent one — see the fail-closed note in the module docstring. */
function presentId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Does this row name a project locus at all (however broken)? */
function namesProject(row: Pick<ArtifactSummary, "projectId">): boolean {
  return row.projectId !== null && row.projectId !== undefined;
}

/**
 * The row's ONE displayed locus, or `null` when the row is fail-closed.
 *
 * The project axis is consulted FIRST and, once it names a project, it is the
 * whole answer — that is the precedence the classification rule binds.
 */
export function resolveArtifactDisplayedLocus(
  row: Pick<ArtifactSummary, "ownerLevel" | "ownerId" | "projectId">,
): ResolvedArtifactLocus | null {
  if (namesProject(row)) {
    const projectId = presentId(row.projectId);
    // An empty / whitespace-only project id names no project: fail closed
    // rather than falling back to the `ownerLevel` axis.
    if (!projectId) return null;
    return { kind: "project", projectId };
  }
  // `projectId IS NULL` — and only then — the row is classified by its owner
  // level and owner id.
  if (row.ownerLevel === "workspace") {
    // The tier above every organization. It carries no owner id by
    // construction, so an owner id is not required of it here.
    return { kind: "workspace" };
  }
  const ownerId = presentId(row.ownerId);
  // MALFORMED: a non-workspace level with a missing owner id.
  if (!ownerId) return null;
  switch (row.ownerLevel) {
    case "user":
      return { kind: "user", ownerId };
    case "team":
      return { kind: "team", ownerId };
    case "organization":
      return { kind: "organization", ownerId };
    default:
      // An unknown level is a locus this reader cannot place: fail closed.
      return null;
  }
}

/** Every organization, team and project id the vantage carries — the workspace
 *  union's authorization set, flattened once per read. */
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
function workspaceOwns(locus: ResolvedArtifactLocus, vantage: WorkspaceVantage): boolean {
  const ids = vantageIds(vantage);
  switch (locus.kind) {
    case "workspace":
      // "a schema-valid workspace-tier row … belongs to the workspace and
      // appears in the workspace union".
      return true;
    case "user":
      return locus.ownerId === vantage.userId;
    case "team":
      return ids.teamIds.has(locus.ownerId);
    case "organization":
      return ids.orgIds.has(locus.ownerId);
    case "project":
      // UNRESOLVED / CROSS-ORG / UNAUTHORIZED all land here: a project the
      // vantage does not carry is not this workspace's to display.
      return ids.projectIds.has(locus.projectId);
  }
}

/** Does the viewed scope own this row? */
function scopeOwns(locus: ResolvedArtifactLocus, scope: ArtifactOwnershipLocus): boolean {
  switch (scope.kind) {
    case "personal":
      return locus.kind === "user" && locus.ownerId === scope.userId;
    case "organization":
      return locus.kind === "organization" && locus.ownerId === scope.orgId;
    case "team":
      return locus.kind === "team" && locus.ownerId === scope.teamId;
    case "project":
      return locus.kind === "project" && locus.projectId === scope.projectId;
    case "workspace":
      return workspaceOwns(locus, scope.vantage);
  }
}

/**
 * The artifacts the VIEWED scope owns, in the order they arrived.
 *
 * The input is the caller's own already-authorized listing (`listArtifacts`
 * applies the object-store ownership filter and the canonical per-row
 * `object.read`), so this reader only ever NARROWS it: a row this returns was
 * already readable by the actor, and a row the actor may not read never reaches
 * it. Ordering is the caller's, untouched, so the tab lists in the same order
 * the library does.
 */
export function selectScopeOwnedArtifacts<Row extends Pick<ArtifactSummary, "ownerLevel" | "ownerId" | "projectId">>(
  rows: readonly Row[],
  scope: ArtifactOwnershipLocus,
): Row[] {
  const owned: Row[] = [];
  for (const row of rows) {
    const locus = resolveArtifactDisplayedLocus(row);
    // Fail closed: an unplaceable row is on no tab at all.
    if (!locus) continue;
    if (!scopeOwns(locus, scope)) continue;
    owned.push(row);
  }
  return owned;
}
