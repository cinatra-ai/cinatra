"use server";
/**
 * Server Actions for the dashboards package.
 *
 * `saveAgentsDashboardAction` is invoked from the /agents screen via the
 * `EmbeddedDrizzleCubeDashboardGrid` `onSave` prop (cinatra#328). It funnels every
 * save through the mutation service's `upsertDashboardConfig`, which
 * is the single writer (audit-event row written inside the
 * same TX; advisory-lock serializes concurrent writers).
 *
 * Invariants:
 *   - Dashboard id is per-org-per-user (cross-org isolation; users in
 *     different orgs see different rows).
 *   - ownerLevel "user" + ownerId=userId means
 *     `canWrite` is satisfied by `row.ownerId === actor.userId` —
 *     no org role required. Every user can edit + save THEIR /agents
 *     layout, regardless of their Better Auth org role.
 *
 * First save materializes the user's row. Second save just updates.
 * Race-freedom + auth checks live in the mutation service.
 */
import { getAuthSession, resolveOrgRoleForUser } from "@/lib/auth-session";
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";
import { OrgWriteRefusedError, type OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

import { DashboardOrgWriteAuthorityError } from "./org-write-seam";

/** Membership-grounded session mint for the actions built on the bare
 *  security context (no resolved role in hand, unlike
 *  buildDashboardActorFromSession). No membership row → undefined → the
 *  org-write seam refuses and classifyMutationError maps it to "denied"
 *  (cinatra#1939 S3). */
async function sessionWriteAuthorityFor(
  userId: string,
  orgId: string,
): Promise<OrgWriteAuthority | undefined> {
  const role = await resolveOrgRoleForUser(orgId, userId);
  return role ? sessionAuthorityFromResolvedRole(orgId, role) : undefined;
}

import { buildSecurityContextFromSession } from "./auth/security-context";
import {
  upsertDashboardConfig,
  listDashboardsForEntity,
  getEntityDashboard,
  createEntityDashboard,
  renameDashboard,
  deleteEntityDashboard,
  ensureOverview,
  updateDashboard,
  DashboardNameConflictError,
  DashboardOverviewProtectedError,
  DashboardForbiddenError,
  DashboardNotFoundError,
  DashboardInvalidEntityError,
  DashboardConfigInvalidError,
} from "./mutation-service";
import { DASHBOARD_CONFIG_V12_VERSION } from "./extension/dashboard-config-v12";
import { buildAgentsDashboardId } from "./components/seed-configs/agents-default";
import { buildProjectsDashboardId } from "./components/seed-configs/projects-default";
import { buildTeamsDashboardId } from "./components/seed-configs/teams-default";
import { buildOrganizationsDashboardId } from "./components/seed-configs/organizations-default";
import { buildArtifactsDashboardId } from "./components/seed-configs/artifacts-default";
import { buildPersonalDashboardId } from "./components/seed-configs/personal-default";
import { resolveDashboardAccess, type DashboardActor } from "./permissions";
import {
  isKnownEntityType,
  isWorkspaceDashboardRef,
  type DashboardEntityRef,
} from "./store/entity-identity";
import type { DashboardRow } from "./store/schema";
import type { DashboardConfigV1_1 } from "./store/dashboard-config";
import { readDcConfigFromRow } from "./v12-envelope";
import type {
  DeletedEntityDashboard,
  EntityDashboardMutationReason,
  EntityDashboardSummary,
  EntityDashboardsList,
  MutatedEntityDashboard,
  SavedEntityDashboard,
} from "./entity-dashboards-contract";

export async function saveAgentsDashboardAction(
  config: unknown,
): Promise<SavedEntityDashboard> {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    throw new Error("saveAgentsDashboardAction: no authenticated session");
  }
  const authority = await sessionWriteAuthorityFor(ctx.userId, ctx.organizationId);
  const actor: DashboardActor = {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    teamIds: ctx.teamIds,
    ...(authority ? { authority } : {}),
  };
  try {
    await upsertDashboardConfig(
      buildAgentsDashboardId(ctx.organizationId, ctx.userId),
      {
        // The grid hands back a bare drizzle-cube config; the mutation service
        // wraps it into the apiVersion 1.2 analytics envelope (cinatra#326 §3b),
        // re-enveloping against the existing row so a re-save preserves scope.
        config,
        configVersion: DASHBOARD_CONFIG_V12_VERSION,
        name: "Agents",
        ownerLevel: "user",
        ownerId: ctx.userId,
      },
      actor,
    );
    return { ok: true };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    if (reason === "invalid-config" && e instanceof Error && e.message) {
      return { ok: false, reason, message: e.message };
    }
    return { ok: false, reason };
  }
}

/**
 * Save actions for the four additional dashboards. Same shape as the
 * agents action — per-org-per-user dashboard id, ownerLevel "user",
 * ownerId = caller's userId — so each user
 * customises their own dashboard layout independently.
 */

async function saveCinatraDashboardAction(
  buildDashboardId: (organizationId: string, userId: string) => string,
  name: string,
  config: unknown,
): Promise<SavedEntityDashboard> {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    throw new Error(`save${name}DashboardAction: no authenticated session`);
  }
  const authority = await sessionWriteAuthorityFor(ctx.userId, ctx.organizationId);
  const actor: DashboardActor = {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    teamIds: ctx.teamIds,
    ...(authority ? { authority } : {}),
  };
  try {
    await upsertDashboardConfig(
      buildDashboardId(ctx.organizationId, ctx.userId),
      {
        // Bare drizzle-cube config in; the mutation service wraps it into the
        // apiVersion 1.2 analytics envelope (cinatra#326 §3b).
        config,
        configVersion: DASHBOARD_CONFIG_V12_VERSION,
        name,
        ownerLevel: "user",
        ownerId: ctx.userId,
      },
      actor,
    );
    return { ok: true };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    if (reason === "invalid-config" && e instanceof Error && e.message) {
      return { ok: false, reason, message: e.message };
    }
    return { ok: false, reason };
  }
}

export async function saveProjectsDashboardAction(
  config: unknown,
): Promise<SavedEntityDashboard> {
  return saveCinatraDashboardAction(buildProjectsDashboardId, "Projects", config);
}

export async function saveTeamsDashboardAction(
  config: unknown,
): Promise<SavedEntityDashboard> {
  return saveCinatraDashboardAction(buildTeamsDashboardId, "Teams", config);
}

export async function saveOrganizationsDashboardAction(
  config: unknown,
): Promise<SavedEntityDashboard> {
  return saveCinatraDashboardAction(
    buildOrganizationsDashboardId,
    "Organizations",
    config,
  );
}

export async function saveArtifactsDashboardAction(config: unknown): Promise<void> {
  await saveCinatraDashboardAction(buildArtifactsDashboardId, "Artifacts", config);
}

export async function savePersonalDashboardAction(config: unknown): Promise<void> {
  await saveCinatraDashboardAction(buildPersonalDashboardId, "Personal", config);
}

// ───────────────────────────────────────────────────────────────────────────
// cinatra#701 — generic entity Dashboards-tab server actions.
//
// A hosting screen (#703 personal, #704 team, #705 org, #706 project) binds its
// SERVER-DERIVED entity ref into these (`action.bind(null, ref)`), so the ref
// crosses to the client Next-ENCRYPTED and the client never authors the owner
// axis. Two guards make this safe (codex round-0):
//   1. `resolveDashboardAccess` re-derives canRead/canWrite from the row's owner
//      fields against the SESSION actor on every call — fail-closed regardless
//      of the ref; and
//   2. every id-taking action re-loads the row and confirms it belongs to the
//      bound ref (`rowMatchesRef`) BEFORE mutating, so a valid id from a
//      DIFFERENT surface the actor also writes cannot be mutated through this
//      surface's binding (confinement).
// The list carries a server-derived `canWrite` per row + a surface `canCreate`,
// so the UI gates edit/create — never an unconditional `editable`.
// ───────────────────────────────────────────────────────────────────────────

/** A minimal valid empty drizzle-cube config — the read fallback for a row
 *  whose stored config is absent/corrupt (created rows carry a valid config). */
const EMPTY_ENTITY_DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as DashboardConfigV1_1;

/** The dashboards-local org-role vocabulary, from either the kernel form or the
 *  Better Auth form. One place, so both actor paths below agree. */
function toDashboardsOrgRole(
  role: string | null | undefined,
): "owner" | "admin" | "member" | undefined {
  if (role === "owner" || role === "org_owner") return "owner";
  if (role === "admin" || role === "org_admin") return "admin";
  if (role === "member") return "member";
  return undefined;
}

/** Build the role-aware dashboards actor from the session (teamIds + orgRole).
 *  teamRoles is not resolved from the session actor — team-OWNED Overviews are a
 *  #704 concern that extends the actor there; user/org ownership is complete.
 *
 *  The WORKSPACE arm (cinatra#2811): a workspace ref is org-NULL, so it needs no
 *  active organization: a user with none still reads and writes their own
 *  workspace dashboards, and the actor's active organization (when present)
 *  plays no part in any workspace decision. The ref must name the SESSION user
 *  as its owner; a ref bound to anyone else is refused here, before any read.
 *
 *  A REF MAY NAME ITS OWN ORGANIZATION (cinatra#3787), and then it chooses the
 *  TENANT, never the authority. A per-instance entity can sit outside the active
 *  organization: the owner's decision on cinatra#3693 puts a scope's surface
 *  under the scope's organization, whatever the session has active, and a team's
 *  ref therefore carries the team's organization. The session-derived default is
 *  untouched for a ref that names none, which is every personal and index
 *  surface.
 *
 *  EVERY EXPORT HERE IS A SERVER ACTION, so a ref is an argument and never a
 *  fact. This path is built on that: it re-derives from the SESSION everything
 *  that could admit anything, and takes from the ref only which tenant to work
 *  in. Two conditions, both fail-closed:
 *
 *    1. the ref must name the SESSION USER'S OWN rows (`ownerLevel: "user"`,
 *       `ownerId` = the session user). The row resolver's user arm then decides
 *       every verdict on `row.ownerId === actor.userId`, so a named organization
 *       cannot reach anyone else's rows. Without this, an organization-owned ref
 *       would put the named organization into `actor.organizationId`, and that
 *       tier's member arm reads `row.ownerId === actor.organizationId` with no
 *       role at all (`resolveDashboardAccess`), which would disclose that
 *       organization's shared rows. Refused here instead, before any read.
 *    2. the session must hold a RESOLVED role in the named organization. A
 *       caller who is a member of nothing there cannot select that tenant, so
 *       neither a read nor a create can reach it. The org-write authority is
 *       minted from that same role and for that same organization, which is what
 *       the org-write seam demands of every write.
 *
 *  What the actor does NOT carry across organizations is a team axis: `teamIds`
 *  is the session's ACTIVE-organization projection, and asserting it under
 *  another tenant would claim a membership this path never read. It is dropped
 *  instead, so nothing widens. Condition 1 makes it unread anyway.
 *
 *  Fail-closed here is not the whole gate, it is the floor. The surface that
 *  binds a team ref authorized the caller against the team first
 *  (`authorizeTeamDashboards`: member or manager, resolved against the team's
 *  organization); this path only guarantees that a ref arriving from anywhere
 *  else can reach nothing the session does not already own. */
async function requireEntityDashboardActor(ref: DashboardEntityRef): Promise<DashboardActor> {
  const { actor: authz, orgId, userId, authority } = await buildDashboardActorFromSession();
  if (isWorkspaceDashboardRef(ref)) {
    if (!userId || ref.ownerId !== userId) {
      throw new Error("entity dashboards: a workspace ref names only the session user");
    }
    return { userId, organizationId: orgId, teamIds: [] };
  }
  if (ref.organizationId && ref.organizationId !== orgId) {
    if (!userId || ref.ownerLevel !== "user" || ref.ownerId !== userId) {
      throw new Error(
        "entity dashboards: a ref names another organization only for the session user's own rows",
      );
    }
    const refOrgRole = await resolveOrgRoleForUser(ref.organizationId, userId);
    if (!refOrgRole) {
      throw new Error(
        "entity dashboards: the session holds no role in the organization the ref names",
      );
    }
    const refRole = toDashboardsOrgRole(refOrgRole);
    return {
      userId,
      organizationId: ref.organizationId,
      teamIds: [],
      ...(refRole ? { orgRole: refRole } : {}),
      authority: sessionAuthorityFromResolvedRole(ref.organizationId, refOrgRole),
    };
  }
  if (!orgId) throw new Error("entity dashboards: no active organization");
  const orgRole = toDashboardsOrgRole(authz.orgRole);
  return {
    userId,
    organizationId: orgId,
    teamIds: authz.teamIds ?? [],
    ...(orgRole ? { orgRole } : {}),
    // cinatra#1939 S3: session-minted org-write authority — writers on the
    // org-write seam (updateDashboard et al.) refuse without it.
    ...(authority ? { authority } : {}),
  };
}

function assertValidRef(ref: DashboardEntityRef): void {
  if (
    !isKnownEntityType(ref.entityType) ||
    !ref.entityId ||
    !ref.ownerLevel ||
    !ref.ownerId
  ) {
    throw new Error("entity dashboards: invalid entity ref");
  }
}

/** Confinement: the row's immutable owner axis must equal the bound ref. */
function rowMatchesRef(row: DashboardRow, ref: DashboardEntityRef): boolean {
  return (
    row.entityType === ref.entityType &&
    row.entityId === ref.entityId &&
    row.ownerLevel === ref.ownerLevel &&
    row.ownerId === ref.ownerId
  );
}

function toSummary(row: DashboardRow, actor: DashboardActor): EntityDashboardSummary {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    canWrite: resolveDashboardAccess(row, actor).canWrite,
  };
}

/** Whether the actor may CREATE a dashboard for this ref. Mirrors the service's
 *  create authz (a non-default pseudo row owned per the ref, run through the
 *  shared resolver); for a human/session actor the resolver reads only
 *  organizationId, ownerLevel, ownerId, projectId (cinatra#1898 Phase-3 retired
 *  the dashboard-local visibility axis with its column). */
function canCreateForRef(ref: DashboardEntityRef, actor: DashboardActor): boolean {
  // The workspace ref's rows are org-NULL (cinatra#2811), so its pseudo row is
  // too, so the resolver's org-NULL arm decides, never the active org.
  const workspace = isWorkspaceDashboardRef(ref);
  const pseudo = {
    organizationId: workspace ? null : actor.organizationId,
    entityType: ref.entityType,
    entityId: ref.entityId,
    ownerLevel: ref.ownerLevel,
    ownerId: ref.ownerId,
    projectId: null,
  } as unknown as DashboardRow;
  return resolveDashboardAccess(pseudo, actor).canWrite;
}

/** Map an expected mutation failure to a client reason; `null` = unexpected. */
function classifyMutationError(e: unknown): EntityDashboardMutationReason | null {
  if (e instanceof DashboardNameConflictError) return "name-conflict";
  if (e instanceof DashboardOverviewProtectedError) return "protected";
  if (e instanceof DashboardForbiddenError) return "denied";
  // Org-write seam refusals (cinatra#1939 S3): missing/mismatched authority
  // and kernel lifecycle rulings are authorization outcomes, same as denied.
  if (e instanceof DashboardOrgWriteAuthorityError) return "denied";
  if (e instanceof OrgWriteRefusedError) return "denied";
  if (e instanceof DashboardNotFoundError) return "not-found";
  if (e instanceof DashboardConfigInvalidError) return "invalid-config";
  if (e instanceof DashboardInvalidEntityError) {
    return /reserved/i.test(String(e.message)) ? "name-reserved" : "name-required";
  }
  return null;
}

/** Ensured Overview-inclusive list + capabilities for the dropdown. */
export async function listEntityDashboardsAction(
  ref: DashboardEntityRef,
): Promise<EntityDashboardsList> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  const rows = await listDashboardsForEntity(ref, actor);
  return {
    dashboards: rows.map((r) => toSummary(r, actor)),
    canCreate: canCreateForRef(ref, actor),
  };
}

/** Idempotently ensure the non-removable Overview exists (surface calls this,
 *  with its entity-summary seed once #702 lands, BEFORE listing). */
export async function ensureEntityOverviewAction(
  ref: DashboardEntityRef,
  seedConfig?: unknown,
): Promise<EntityDashboardSummary> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  const row = await ensureOverview(
    { ref, ...(seedConfig !== undefined ? { seedConfig } : {}) },
    actor,
  );
  return toSummary(row, actor);
}

/** The unwrapped drizzle-cube config for one dashboard id (ref-confined). */
export async function getEntityDashboardConfigAction(
  ref: DashboardEntityRef,
  id: string,
): Promise<DashboardConfigV1_1> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  const row = await getEntityDashboard(id, actor);
  if (!row || !rowMatchesRef(row, ref)) throw new DashboardNotFoundError(id);
  return readDcConfigFromRow<DashboardConfigV1_1>(row, EMPTY_ENTITY_DC);
}

/** Create a named (non-default) dashboard, seeded empty. */
export async function createEntityDashboardAction(
  ref: DashboardEntityRef,
  name: string,
): Promise<MutatedEntityDashboard> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  try {
    const row = await createEntityDashboard({ ref, name }, actor);
    return { ok: true, dashboard: toSummary(row, actor) };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    return { ok: false, reason };
  }
}

/** Rename a dashboard (ref-confined; the service denies the Overview default). */
export async function renameEntityDashboardAction(
  ref: DashboardEntityRef,
  id: string,
  name: string,
): Promise<MutatedEntityDashboard> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  const existing = await getEntityDashboard(id, actor);
  if (!existing || !rowMatchesRef(existing, ref)) {
    return { ok: false, reason: "not-found" };
  }
  try {
    const row = await renameDashboard(id, name, actor);
    return { ok: true, dashboard: toSummary(row, actor) };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    return { ok: false, reason };
  }
}

/** Delete a dashboard (ref-confined; the service denies the Overview default). */
export async function deleteEntityDashboardAction(
  ref: DashboardEntityRef,
  id: string,
): Promise<DeletedEntityDashboard> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  const existing = await getEntityDashboard(id, actor);
  if (!existing || !rowMatchesRef(existing, ref)) {
    return { ok: false, reason: "not-found" };
  }
  try {
    await deleteEntityDashboard(id, actor);
    return { ok: true };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    return { ok: false, reason };
  }
}

/** Persist the selected dashboard's edited config (config-only patch is
 *  Overview-safe; the service re-envelopes against the existing row).
 *  cinatra#1913: returns a typed result like every other mutation — a
 *  validation failure carries the validator's card-naming copy in `message`
 *  and never escapes as a raw server error. */
export async function saveEntityDashboardConfigAction(
  ref: DashboardEntityRef,
  id: string,
  config: unknown,
): Promise<SavedEntityDashboard> {
  assertValidRef(ref);
  const actor = await requireEntityDashboardActor(ref);
  const existing = await getEntityDashboard(id, actor);
  if (!existing || !rowMatchesRef(existing, ref)) {
    return { ok: false, reason: "not-found" };
  }
  try {
    await updateDashboard(id, { config }, actor);
    return { ok: true };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    if (reason === "invalid-config" && e instanceof Error && e.message) {
      return { ok: false, reason, message: e.message };
    }
    return { ok: false, reason };
  }
}
