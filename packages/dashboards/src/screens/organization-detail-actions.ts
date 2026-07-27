"use server";
/**
 * Server actions for the `/organizations/[id]` Dashboards tab (cinatra#705).
 *
 * Why these exist instead of the generic entity-dashboards actions in
 * `../actions.ts`: those derive the dashboards TENANT from the session's ACTIVE
 * organization. That is correct for the surfaces whose entity lives inside the
 * active org (personal / team / project detail), but the ORGANIZATION detail
 * surface is unique — its `entityId` IS an organization, which may differ from
 * the viewer's active org (a multi-org member opening a non-active org from the
 * list). Under the generic actions that divergence would (a) store the org's
 * dashboards under the wrong tenant, (b) make the set change with the active
 * org, and (c) collide on the tenant-independent Overview id when the same
 * (org, user) is ensured under two different active-org tenants (a PK clash →
 * 500). So this surface scopes the dashboards tenant to the VIEWED org
 * (`ref.entityId`), membership-verified on EVERY call (defense-in-depth beyond
 * the screen's render-time gate — a viewer who loses membership can no longer
 * mutate), which is the only self-consistent tenant for an org-detail entity.
 *
 * Everything else mirrors `../actions.ts`: the ref is server-bound
 * (`action.bind(null, ref)`, Next-encrypted); `resolveDashboardAccess`
 * re-derives canRead/canWrite from the row owner fields against the actor
 * (fail-closed, and the tenant check `row.organizationId === actor.organizationId`
 * still runs); and every id-taking action reloads the row and confirms it
 * belongs to the bound ref (`rowMatchesRef`) before mutating.
 */
import { requireAuthSession } from "@/lib/auth-session";
import { readUserIsOrgMember } from "@/lib/better-auth-db";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";
import { OrgWriteRefusedError } from "@cinatra-ai/org-write-kernel";

import { DashboardOrgWriteAuthorityError } from "../org-write-seam";

import {
  DashboardConfigInvalidError,
  DashboardForbiddenError,
  DashboardInvalidEntityError,
  DashboardNameConflictError,
  DashboardNotFoundError,
  DashboardOverviewProtectedError,
  createEntityDashboard,
  deleteEntityDashboard,
  ensureOverview,
  getEntityDashboard,
  listDashboardsForEntity,
  renameDashboard,
  updateDashboard,
} from "../mutation-service";
import { resolveDashboardAccess, type DashboardActor } from "../permissions";
import type {
  DeletedEntityDashboard,
  EntityDashboardMutationReason,
  EntityDashboardSummary,
  EntityDashboardsList,
  MutatedEntityDashboard,
  SavedEntityDashboard,
} from "../entity-dashboards-contract";
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import type { DashboardEntityRef } from "../store/entity-identity";
import type { DashboardRow } from "../store/schema";
import { readDcConfigFromRow } from "../v12-envelope";

/** A minimal valid empty drizzle-cube config — the read fallback for a row whose
 *  stored config is absent/corrupt (created rows carry a valid config). */
const EMPTY_ENTITY_DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as DashboardConfigV1_1;

/** This surface only ever addresses the per-instance `organization` entity. */
function assertOrgDetailRef(ref: DashboardEntityRef): void {
  if (
    ref.entityType !== "organization" ||
    !ref.entityId ||
    ref.ownerLevel !== "user" ||
    !ref.ownerId
  ) {
    throw new DashboardInvalidEntityError("organization detail: invalid entity ref");
  }
}

/**
 * Build the dashboards actor for THIS org detail surface: the session user,
 * tenanted to the VIEWED org (`ref.entityId`), verified as a member on every
 * call. The org-detail Dashboards are all user-owned + private, so
 * `resolveDashboardAccess` needs only `userId` + `organizationId` (tenant) — no
 * team/org roles are consulted for a user-owned row. A non-member is denied.
 */
async function requireOrgMemberActor(orgId: string): Promise<DashboardActor> {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const isMember = await readUserIsOrgMember(userId, orgId);
  if (!isMember) {
    throw new DashboardForbiddenError("dashboards.read", orgId);
  }
  return {
    userId,
    organizationId: orgId,
    teamIds: [],
    // cinatra#1939 S3: the membership check above IS the session grounding —
    // mint the MEMBER-floor authority (content.write only; never widens even
    // when the caller's real role is higher — no dashboards writer needs a
    // management capability).
    authority: sessionAuthorityFromResolvedRole(orgId, "member"),
  };
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

/** Whether the actor may CREATE a dashboard for this ref (mirrors the service's
 *  create authz: a private, non-default pseudo row owned per the ref). */
function canCreateForRef(ref: DashboardEntityRef, actor: DashboardActor): boolean {
  const pseudo = {
    organizationId: actor.organizationId,
    ownerLevel: ref.ownerLevel,
    ownerId: ref.ownerId,
    visibility: "private",
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

/** Ensure the org's non-removable Overview exists (empty seed — the rendered
 *  content is EPHEMERAL, built fresh by the surface), then return the
 *  Overview-inclusive list + capabilities. The shell's contract requires the
 *  surface to ensure the Overview BEFORE listing. */
export async function ensureAndListOrganizationDashboardsAction(
  ref: DashboardEntityRef,
): Promise<EntityDashboardsList> {
  assertOrgDetailRef(ref);
  const actor = await requireOrgMemberActor(ref.entityId);
  await ensureOverview({ ref }, actor);
  const rows = await listDashboardsForEntity(ref, actor);
  return {
    dashboards: rows.map((r) => toSummary(r, actor)),
    canCreate: canCreateForRef(ref, actor),
  };
}

/** The unwrapped drizzle-cube config for one dashboard id (ref-confined). */
export async function getOrganizationDashboardConfigAction(
  ref: DashboardEntityRef,
  id: string,
): Promise<DashboardConfigV1_1> {
  assertOrgDetailRef(ref);
  const actor = await requireOrgMemberActor(ref.entityId);
  const row = await getEntityDashboard(id, actor);
  if (!row || !rowMatchesRef(row, ref)) throw new DashboardNotFoundError(id);
  return readDcConfigFromRow<DashboardConfigV1_1>(row, EMPTY_ENTITY_DC);
}

/** Create a named (non-default) dashboard, seeded empty. */
export async function createOrganizationDashboardAction(
  ref: DashboardEntityRef,
  name: string,
): Promise<MutatedEntityDashboard> {
  assertOrgDetailRef(ref);
  try {
    // Actor resolution is INSIDE the try so a membership-loss denial
    // (DashboardForbiddenError) is classified to `{ ok: false, reason: "denied" }`
    // rather than thrown across the RSC boundary — the mutation-result contract
    // returns expected failures as data (codex convergence, #705).
    const actor = await requireOrgMemberActor(ref.entityId);
    const row = await createEntityDashboard({ ref, name }, actor);
    return { ok: true, dashboard: toSummary(row, actor) };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    return { ok: false, reason };
  }
}

/** Rename a dashboard (ref-confined; the service denies the Overview default). */
export async function renameOrganizationDashboardAction(
  ref: DashboardEntityRef,
  id: string,
  name: string,
): Promise<MutatedEntityDashboard> {
  assertOrgDetailRef(ref);
  try {
    // Actor resolution + the confinement lookup are INSIDE the try so a
    // membership-loss denial classifies to `denied` instead of throwing.
    const actor = await requireOrgMemberActor(ref.entityId);
    const existing = await getEntityDashboard(id, actor);
    if (!existing || !rowMatchesRef(existing, ref)) {
      return { ok: false, reason: "not-found" };
    }
    const row = await renameDashboard(id, name, actor);
    return { ok: true, dashboard: toSummary(row, actor) };
  } catch (e) {
    const reason = classifyMutationError(e);
    if (!reason) throw e;
    return { ok: false, reason };
  }
}

/** Delete a dashboard (ref-confined; the service denies the Overview default). */
export async function deleteOrganizationDashboardAction(
  ref: DashboardEntityRef,
  id: string,
): Promise<DeletedEntityDashboard> {
  assertOrgDetailRef(ref);
  try {
    // Actor resolution + the confinement lookup are INSIDE the try so a
    // membership-loss denial classifies to `denied` instead of throwing.
    const actor = await requireOrgMemberActor(ref.entityId);
    const existing = await getEntityDashboard(id, actor);
    if (!existing || !rowMatchesRef(existing, ref)) {
      return { ok: false, reason: "not-found" };
    }
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
 *  cinatra#1913: typed result — a validation failure carries the validator's
 *  card-naming copy in `message`, never a raw server error. */
export async function saveOrganizationDashboardConfigAction(
  ref: DashboardEntityRef,
  id: string,
  config: unknown,
): Promise<SavedEntityDashboard> {
  assertOrgDetailRef(ref);
  const actor = await requireOrgMemberActor(ref.entityId);
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
