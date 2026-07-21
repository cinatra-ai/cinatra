import "server-only";

import { sql } from "drizzle-orm";

import { betterAuthDb } from "@/lib/better-auth-db";
import { resolveOrganizationLifecycleEligibility } from "@/lib/organization-lifecycle";

/**
 * Organization DELETE — the reference-guarded transactional core (cinatra#1510).
 *
 * BLOCK-IF-REFERENCED, never cascade: an organization deletes only when nothing
 * with its OWN lifecycle still lives in it. Anything the user manages on its own
 * surface — teams, active projects, connectors, non-default dashboards, agents —
 * BLOCKS the delete with a precise per-kind count, and is never silently
 * destroyed from an org-delete confirmation. Only the org's own furniture goes
 * with it: memberships, pending invitations, the entity-anchored default
 * Overview dashboard rows, and (hazard 2) every session still pointing at the
 * org as its active org is re-pointed to NULL — atomically, in ONE transaction.
 *
 * Deliberately NOT the Better Auth `deleteOrganization` endpoint: its adapter
 * transaction deletes only member + invitation + organization rows (verified in
 * 1.6.23) — teams would survive as orphans and dangling `activeOrganizationId`
 * sessions would keep pointing at a dead org. The catalog gate
 * (`organization.delete`, re-checked by the calling action) remains the
 * authorization authority; direct better-auth-table writes follow the
 * bootstrap/drizzle-store precedent.
 *
 * FK CASCADE companions (schema truth, drizzle-store.ts): `role_grant.org_id`,
 * `connector_access_policy.org_id`, and `project_access.principal_org_id` all
 * reference `public."organization"(id) ON DELETE CASCADE` — deleting the org
 * row cleans them; no explicit statements needed.
 *
 * Known-inert remainders (disclosed, not blockers): ARCHIVED project rows —
 * projects are archive-only by design ("No projects_delete ever"), so blocking
 * on them would make any org that ever had a project permanently undeletable.
 * They keep their `organization_id` as history and are unreachable once the org
 * is gone (every project read enters through an org context).
 */

export type OrganizationDeleteBlockers = {
  /** Better Auth teams in the org (each has its own manage/delete surface). */
  readonly teams: number;
  /** ACTIVE (non-archived) projects — archived rows are inert history. */
  readonly activeProjects: number;
  /** Installed connector extensions in the org (carry credentials/config). */
  readonly connectors: number;
  /** Non-default dashboard rows carrying this org (user content; the
   *  entity-anchored default Overview rows are furniture and delete with it). */
  readonly dashboards: number;
  /** Agents belonging to the org (`org_id`) or scoped to it (`origin.scope`). */
  readonly agents: number;
};

export function hasOrganizationDeleteBlockers(
  blockers: OrganizationDeleteBlockers,
): boolean {
  return (
    blockers.teams > 0 ||
    blockers.activeProjects > 0 ||
    blockers.connectors > 0 ||
    blockers.dashboards > 0 ||
    blockers.agents > 0
  );
}

export type OrganizationDeleteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "blocked";
      readonly blockers: OrganizationDeleteBlockers;
    }
  | { readonly ok: false; readonly reason: "not-found" }
  | { readonly ok: false; readonly reason: "default-org" }
  | { readonly ok: false; readonly reason: "single-org-mode" }
  | { readonly ok: false; readonly reason: "denied" }
  | { readonly ok: false; readonly reason: "error"; readonly error: string };

type SqlExecutor = Pick<typeof betterAuthDb, "execute">;

function appSchema(): string {
  return (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll(
    '"',
    '""',
  );
}

async function countBlockers(
  db: SqlExecutor,
  organizationId: string,
): Promise<OrganizationDeleteBlockers> {
  const schema = appSchema();
  const result = await db.execute<{
    teams: string | number;
    active_projects: string | number;
    connectors: string | number;
    dashboards: string | number;
    agents: string | number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM public."team"
        WHERE "organizationId" = ${organizationId}) AS teams,
      (SELECT count(*) FROM "${sql.raw(schema)}"."projects"
        WHERE organization_id = ${organizationId}
          AND archived_at IS NULL) AS active_projects,
      (SELECT count(*) FROM "${sql.raw(schema)}"."installed_extension"
        WHERE organization_id = ${organizationId}
          AND kind = 'connector') AS connectors,
      (SELECT count(*) FROM "${sql.raw(schema)}"."dashboards"
        WHERE organization_id = ${organizationId}
          AND is_default = false) AS dashboards,
      (SELECT count(*) FROM "${sql.raw(schema)}"."agent_templates"
        WHERE org_id = ${organizationId}
           OR origin->>'scope' = 'org:' || ${organizationId}) AS agents
  `);
  const row = result.rows[0];
  return {
    teams: Number(row?.teams ?? 0),
    activeProjects: Number(row?.active_projects ?? 0),
    connectors: Number(row?.connectors ?? 0),
    dashboards: Number(row?.dashboards ?? 0),
    agents: Number(row?.agents ?? 0),
  };
}

/**
 * UX pre-count for the danger card ("what's in the way"). Advisory only — the
 * transactional delete re-counts under the org-row lock; this read is never the
 * authority.
 */
export async function countOrganizationDeleteBlockers(
  organizationId: string,
): Promise<OrganizationDeleteBlockers> {
  return countBlockers(betterAuthDb, organizationId);
}

/** Thrown inside the transaction to roll back on an in-tx blocker hit. */
class DeleteBlockedError extends Error {
  constructor(readonly blockers: OrganizationDeleteBlockers) {
    super("organization delete blocked by referenced records");
  }
}
class DeleteNotFoundError extends Error {}
class DeleteDefaultOrgError extends Error {}
class DeleteDeniedError extends Error {}

/**
 * Delete the organization if — and only if — nothing blocks it, in one
 * SERIALIZABLE transaction: lock the org row, re-count the blockers under the
 * lock (the pre-count is UX only), then delete the furniture, clear dangling
 * active-org sessions, and delete the org row with an exact affected-row
 * assertion. Any blocker, missing row, or assertion failure rolls the whole
 * transaction back — partial state is structurally impossible.
 *
 * The caller (the server action) owns the first AUTHORIZATION check (viewed-org
 * catalog gate) and the name-confirmation; this module owns the data-integrity
 * guards AND re-verifies both structural hazards and the actor's owner
 * membership at delete time, so a gate result that went stale between the
 * capability read and the commit (mode toggled, actor demoted/removed) still
 * fails closed.
 */
export async function deleteOrganizationReferenceGuarded(
  organizationId: string,
  actorUserId: string,
): Promise<OrganizationDeleteResult> {
  const schema = appSchema();
  try {
    // Structural re-check at delete time (hazard 3) via the shared lifecycle
    // primitive (cinatra#1937). HARDENED over the pre-#1937 shape: a failing
    // single-org config read now REFUSES the delete (fail closed) instead of
    // assuming multi-org. The in-tx row-locked slug/owner re-checks below stay
    // authoritative — this is the pre-transaction fence.
    const eligibility =
      await resolveOrganizationLifecycleEligibility(organizationId);
    if (!eligibility.eligible) {
      switch (eligibility.reason) {
        case "single-org-mode":
          return { ok: false, reason: "single-org-mode" };
        case "default-org":
          return { ok: false, reason: "default-org" };
        case "not-found":
          return { ok: false, reason: "not-found" };
        case "mode-unavailable":
        case "lookup-failed":
          return {
            ok: false,
            reason: "error",
            error: `lifecycle eligibility unavailable (${eligibility.reason}); refusing fail-closed`,
          };
      }
    }
    await betterAuthDb.transaction(
      async (tx) => {
        const locked = await tx.execute<{ id: string; slug: string | null }>(sql`
          SELECT id, slug FROM public."organization"
          WHERE id = ${organizationId}
          FOR UPDATE
        `);
        const org = locked.rows[0];
        if (!org) throw new DeleteNotFoundError();
        // In-tx structural re-check: the bootstrap recreates slug='default' on
        // boot, so deleting it is a no-op treadmill — refuse (hazard 1).
        if (org.slug === "default") throw new DeleteDefaultOrgError();

        // In-tx authz re-verify: the actor must STILL be an owner of this org
        // (member.role='owner' is exactly what the gate maps to org_owner, the
        // only role holding organization.delete). A demotion/removal racing the
        // capability read rolls the delete back.
        const ownerRow = await tx.execute(sql`
          SELECT 1 AS is_owner FROM public."member"
          WHERE "organizationId" = ${organizationId}
            AND "userId" = ${actorUserId}
            AND role = 'owner'
          LIMIT 1
        `);
        if (ownerRow.rows.length === 0) throw new DeleteDeniedError();

        const blockers = await countBlockers(tx, organizationId);
        if (hasOrganizationDeleteBlockers(blockers)) {
          throw new DeleteBlockedError(blockers);
        }

        // Furniture: the entity-anchored default Overview dashboard rows.
        await tx.execute(sql`
          DELETE FROM "${sql.raw(schema)}"."dashboards"
          WHERE organization_id = ${organizationId} AND is_default = true
        `);
        await tx.execute(sql`
          DELETE FROM public."invitation"
          WHERE "organizationId" = ${organizationId}
        `);
        await tx.execute(sql`
          DELETE FROM public."member"
          WHERE "organizationId" = ${organizationId}
        `);
        // Hazard 2: no session may keep pointing at the deleted org.
        await tx.execute(sql`
          UPDATE public."session" SET "activeOrganizationId" = NULL
          WHERE "activeOrganizationId" = ${organizationId}
        `);
        const deleted = await tx.execute(sql`
          DELETE FROM public."organization" WHERE id = ${organizationId}
        `);
        if (deleted.rowCount !== 1) {
          throw new Error(
            `organization delete affected ${String(deleted.rowCount)} rows (expected 1)`,
          );
        }
      },
      { isolationLevel: "serializable" },
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof DeleteBlockedError) {
      return { ok: false, reason: "blocked", blockers: err.blockers };
    }
    if (err instanceof DeleteNotFoundError) {
      return { ok: false, reason: "not-found" };
    }
    if (err instanceof DeleteDefaultOrgError) {
      return { ok: false, reason: "default-org" };
    }
    if (err instanceof DeleteDeniedError) {
      return { ok: false, reason: "denied" };
    }
    const message =
      err instanceof Error && err.message ? err.message : "delete failed";
    return { ok: false, reason: "error", error: message };
  }
}
