import "server-only";

// ---------------------------------------------------------------------------
// THE PER-SCOPE ASSIGNMENT TARGET, RE-RESOLVED ON THE SERVER (cinatra#2814,
// per-scope assignment S2, epic #2812).
//
// Every read the assignment page takes and every write its actions take starts
// here, from nothing the browser can decide:
//
//   1. THE PACKAGE. The address names a pair (`<vendor>/<packageName>` for an
//      agent, the chat codec's `<vendor>/<slug>` for an assistant), and both
//      denote the extension package `@vendor/name`. The pair is re-resolved
//      against the SAME rows the scope's Agents or Assistants tab lists for
//      this reader, behind that tab's own eligibility fence. A pair the tab
//      would not list (a forged, uninstalled, archived or out-of-scope
//      package, or an assistant addressed through the agents tree) resolves to
//      nothing, and the page answers "not found".
//
//   2. THE SCOPE. The route implies it; there is no picker. The personal scope
//      is the session's own user. On the workspace page the scopes are the
//      normative `WorkspaceVantage` (the workspace tier, the personal scope,
//      then every member organization with its visible teams and projects).
//
//   3. THE AUTHORITY. Each scope's actor is re-resolved IN the organization
//      the scope belongs to (`resolveActorGrantsForUserInOrg`), exactly as the
//      eligibility read anchors its actor arm, because an admin of one
//      organization is an ordinary member of the next. The write decision is
//      then S1's exact-scope resolver through `decideScopeAssignmentWrite`,
//      and a scope the reader may not even READ (S1's read resolver) is not
//      shown at all.
//
// The I/O is injected so the fixtures drive every branch without a database;
// the defaults import lazily, because this module is reached only once a
// request has picked the settings shape.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
import { resolveAssignmentReadAuthority } from "@/lib/authz/assignment-authority";
import type { AssignmentScope } from "@/lib/assignment-scope";
import type { ScopeAgentCardRow, ScopeAssistantCardRow } from "@/lib/scope-surface-rows";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";
import {
  buildWorkspaceVantage,
  resolveVantageOrgForScope,
  type WorkspaceVantage,
} from "@/lib/scope-surface-vantage";
import {
  assignmentScopeForSurfaceScope,
  buildWorkspaceEditorScopes,
  decideScopeAssignmentWrite,
  sameSurfaceScope,
  type ScopeAssignmentSurface,
  type ScopeAssignmentWriteDecision,
  type WorkspaceEditorScope,
} from "./scope-assignment-model";

/** What the address (or an action's input) names. Untrusted by construction. */
export type ScopeAssignmentTargetInput = {
  surface: ScopeAssignmentSurface;
  /** The scope the route is mounted under. */
  scope: ScopeSurfaceRef;
  vendor: string;
  /** The package half of the pair: the package name (agents) or the slug
   *  (assistants). */
  name: string;
};

/** The admission verdict S1's write-target gate returns. */
export type ScopeAssignmentAdmission =
  | { ok: true }
  | { ok: false; reason: "not-an-agent" | "eligibility-unreadable" };

/** One scope the page shows, with the reader's authority there. */
export type ScopeAssignmentSection = {
  scope: ScopeSurfaceRef;
  assignmentScope: AssignmentScope;
  /** The organization the scope's authority is read in; `null` for the
   *  workspace tier and the personal scope. */
  orgId: string | null;
  /** The actor, anchored to `orgId`. Server-only: never serialized. */
  actor: ActorContext;
  write: ScopeAssignmentWriteDecision;
};

export type ResolvedScopeAssignmentTarget = {
  surface: ScopeAssignmentSurface;
  routeScope: ScopeSurfaceRef;
  /** The canonical extension package, `@vendor/name`. */
  packageName: string;
  displayName: string;
  userId: string;
  activeOrgId: string | null;
  /** The scopes, in page order. One on every page but the workspace's. */
  sections: ScopeAssignmentSection[];
  /** Display names of the scopes the reader belongs to, keyed `kind:id`. */
  scopeNames: Readonly<Record<string, string>>;
  /** S1's assignment-target admission for the package. */
  admission: ScopeAssignmentAdmission;
};

export type ScopeAssignmentMembership = {
  vantage: WorkspaceVantage;
  scopeNames: Record<string, string>;
};

export type ScopeAssignmentTargetDeps = {
  readSession: () => Promise<{ userId: string; activeOrgId: string | null } | null>;
  readBaseActor: () => Promise<ActorContext>;
  readGrantsInOrg: (
    userId: string,
    orgId: string,
  ) => Promise<{
    projectGrants: NonNullable<ActorContext["projectGrants"]>;
    teamIds: string[];
    teamRoles?: ActorContext["teamRoles"];
    orgRole?: ActorContext["orgRole"];
  }>;
  readMembership: (userId: string) => Promise<ScopeAssignmentMembership>;
  readAgentRows: (scope: ScopeSurfaceRef) => Promise<readonly ScopeAgentCardRow[]>;
  readAssistantRows: (scope: ScopeSurfaceRef) => Promise<readonly ScopeAssistantCardRow[]>;
  assertWriteTarget: (packageName: string) => Promise<ScopeAssignmentAdmission>;
};

/** The key a scope's display name is stored under. */
export function scopeNameKey(scope: ScopeSurfaceRef): string {
  return "id" in scope ? `${scope.kind}:${scope.id}` : scope.kind;
}

function isSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s/@]/.test(value);
}

function isScopeRef(value: unknown): value is ScopeSurfaceRef {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "workspace" || kind === "personal") return true;
  if (kind === "organization" || kind === "team" || kind === "project") {
    return isSegment((value as { id?: unknown }).id);
  }
  return false;
}

/** Anchor the session actor to one organization, re-resolving every axis the
 *  S1 resolver reads there. */
async function anchoredActor(
  base: ActorContext,
  userId: string,
  orgId: string,
  deps: ScopeAssignmentTargetDeps,
): Promise<ActorContext> {
  const grants = await deps.readGrantsInOrg(userId, orgId);
  return {
    ...base,
    organizationId: orgId,
    teamIds: grants.teamIds,
    projectGrants: grants.projectGrants,
    projectIds: grants.projectGrants.map((g) => g.projectId).sort(),
    orgRole: grants.orgRole,
    teamRoles: grants.teamRoles,
  };
}

/**
 * Resolve what the page is FOR, for this reader, or `null` when the reader
 * reaches no such package at this scope. Never throws for a reader-caused
 * reason: a failed read resolves to `null` (the page then answers not found,
 * and an action refuses).
 */
export async function resolveScopeAssignmentTarget(
  input: ScopeAssignmentTargetInput,
  deps: ScopeAssignmentTargetDeps = defaultScopeAssignmentTargetDeps,
): Promise<ResolvedScopeAssignmentTarget | null> {
  if (input?.surface !== "agent" && input?.surface !== "assistant") return null;
  if (!isScopeRef(input.scope) || !isSegment(input.vendor) || !isSegment(input.name)) return null;

  const session = await deps.readSession();
  if (!session?.userId) return null;
  const { userId, activeOrgId } = session;

  // (1) THE PACKAGE, from the rows this scope's tab lists for this reader.
  let packageName: string;
  let displayName: string;
  if (input.surface === "agent") {
    const wanted = `@${input.vendor}/${input.name}`;
    const row = (await deps.readAgentRows(input.scope)).find((r) => r.packageName === wanted);
    if (!row) return null;
    packageName = row.packageName;
    displayName = row.name;
  } else {
    const row = (await deps.readAssistantRows(input.scope)).find(
      (r) => r.vendor === input.vendor && r.slug === input.name,
    );
    if (!row) return null;
    packageName = row.packageName;
    displayName = row.displayName;
  }

  // (2) THE SCOPES, from the reader's own memberships.
  const { vantage, scopeNames } = await deps.readMembership(userId);
  let scopes: WorkspaceEditorScope[];
  if (input.scope.kind === "workspace") {
    scopes = buildWorkspaceEditorScopes(vantage);
  } else if (input.scope.kind === "personal") {
    scopes = [{ scope: input.scope, orgId: null }];
  } else {
    const orgId = resolveVantageOrgForScope(vantage, input.scope, activeOrgId);
    // FAIL CLOSED: a scope the reader's memberships do not reach is no page.
    if (!orgId) return null;
    scopes = [{ scope: input.scope, orgId }];
  }

  // (3) THE AUTHORITY, per scope, in the scope's own organization.
  const base = await deps.readBaseActor();
  const actors = new Map<string, Promise<ActorContext>>();
  const actorFor = (orgId: string | null): Promise<ActorContext> => {
    if (!orgId) return Promise.resolve(base);
    let hit = actors.get(orgId);
    if (!hit) {
      hit = anchoredActor(base, userId, orgId, deps);
      actors.set(orgId, hit);
    }
    return hit;
  };

  const sections: ScopeAssignmentSection[] = [];
  const seen = new Set<string>();
  for (const entry of scopes) {
    const key = scopeNameKey(entry.scope);
    if (seen.has(key)) continue;
    const assignmentScope = assignmentScopeForSurfaceScope(entry.scope, userId);
    if (!assignmentScope) continue;
    const actor = await actorFor(entry.orgId);
    // A scope the reader may not READ is not shown at all. On a single-scope
    // page that is the whole page; on the workspace page it is one section.
    if (!resolveAssignmentReadAuthority(actor, assignmentScope).allowed) continue;
    seen.add(key);
    sections.push({
      scope: entry.scope,
      assignmentScope,
      orgId: entry.orgId,
      actor,
      write: decideScopeAssignmentWrite(actor, assignmentScope),
    });
  }
  if (sections.length === 0) return null;
  if (input.scope.kind !== "workspace" && !sameSurfaceScope(sections[0].scope, input.scope)) {
    return null;
  }

  const admission = await deps.assertWriteTarget(packageName);
  return {
    surface: input.surface,
    routeScope: input.scope,
    packageName,
    displayName,
    userId,
    activeOrgId,
    sections,
    scopeNames,
    admission,
  };
}

/**
 * The section an action writes to. On a single-scope page it is the page's
 * scope; on the workspace page it must be one of the sections the page itself
 * shows. `null` otherwise: a mutation naming any other scope never reaches a
 * store.
 */
export function selectScopeAssignmentSection(
  target: ResolvedScopeAssignmentTarget,
  section: ScopeSurfaceRef | null | undefined,
): ScopeAssignmentSection | null {
  if (target.routeScope.kind !== "workspace") {
    if (section && !sameSurfaceScope(section, target.routeScope)) return null;
    return target.sections[0] ?? null;
  }
  if (!isScopeRef(section)) return null;
  return target.sections.find((s) => sameSurfaceScope(s.scope, section)) ?? null;
}

// ---------------------------------------------------------------------------
// The production I/O.
// ---------------------------------------------------------------------------

async function readSessionDefault(): Promise<{ userId: string; activeOrgId: string | null } | null> {
  const { getAuthSession } = await import("@/lib/auth-session");
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!session || !userId) return null;
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  return { userId, activeOrgId };
}

/**
 * Fold the reader's memberships into the workspace vantage and the scope
 * names the page labels its sections with.
 *
 * The actor-visible project reader is a union across every organization the
 * reader belongs to (it never reads its organization argument), so each
 * project is filed under the organization its own row names, and a project
 * whose organization is not one of the reader's current, non-archived
 * memberships is dropped. Filing it under every organization would read its
 * authority, its artifacts and its audit row in the wrong tenant.
 */
export function foldScopeAssignmentMembership(input: {
  userId: string;
  orgs: ReadonlyArray<{ id: string; name: string; teams: ReadonlyArray<{ id: string; name: string }> }>;
  projects: ReadonlyArray<{ id: string; name: string; organizationId: string | null }>;
}): ScopeAssignmentMembership {
  const scopeNames: Record<string, string> = {};
  const teamIdsByOrg: Record<string, string[]> = {};
  const projectIdsByOrg: Record<string, string[]> = {};
  for (const org of input.orgs) {
    scopeNames[`organization:${org.id}`] = org.name;
    teamIdsByOrg[org.id] = org.teams.map((t) => t.id);
    projectIdsByOrg[org.id] = [];
    for (const team of org.teams) scopeNames[`team:${team.id}`] = team.name;
  }
  for (const project of input.projects) {
    const orgId = project.organizationId;
    if (!orgId || !projectIdsByOrg[orgId]) continue;
    projectIdsByOrg[orgId].push(project.id);
    scopeNames[`project:${project.id}`] = project.name;
  }
  const vantage = buildWorkspaceVantage({
    userId: input.userId,
    memberships: input.orgs.map((org) => ({ orgId: org.id })),
    teamIdsByOrg,
    projectIdsByOrg,
  });
  return { vantage, scopeNames };
}

async function readMembershipDefault(userId: string): Promise<ScopeAssignmentMembership> {
  const [{ readOrgsWithTeamsForUserActiveOnly, readProjectsForUser }, { readProjectById }] =
    await Promise.all([import("@/lib/better-auth-db"), import("@/lib/projects-store-dao")]);
  const orgs = await readOrgsWithTeamsForUserActiveOnly(userId);
  const visible = orgs.length > 0 ? await readProjectsForUser(userId, orgs[0].id) : [];
  const projects = await Promise.all(
    visible.map(async (p) => ({
      id: p.id,
      name: p.name,
      organizationId: (await readProjectById(p.id))?.organizationId ?? null,
    })),
  );
  return foldScopeAssignmentMembership({ userId, orgs, projects });
}

export const defaultScopeAssignmentTargetDeps: ScopeAssignmentTargetDeps = {
  readSession: readSessionDefault,
  readBaseActor: async () => (await import("@/lib/auth-session")).requireActorContext(),
  readGrantsInOrg: async (userId, orgId) =>
    (await import("@/lib/auth-session")).resolveActorGrantsForUserInOrg(userId, orgId),
  readMembership: readMembershipDefault,
  readAgentRows: async (scope) =>
    (await import("@/lib/scope-surface-eligibility.server")).readScopeSurfaceAgentRows(scope),
  readAssistantRows: async (scope) =>
    (await import("@/lib/scope-surface-eligibility.server")).readScopeSurfaceAssistantRows(scope),
  assertWriteTarget: async (packageName) =>
    (await import("@cinatra-ai/skills/agent-package-resolver")).assertAgentWriteTarget(packageName),
};
