import "server-only";

import { sql, type SQL } from "drizzle-orm";

import {
  guardOrgLifecycleMutation,
  OrgWriteRefusedError,
  type OrgWriteCapability,
  type OrgWriteDb,
  type OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";
import { TERMINAL_RUN_STATUSES } from "@cinatra-ai/agents/run-status";

import { betterAuthDb } from "@/lib/better-auth-db";
import { resolveOrganizationLifecycleEligibility } from "@/lib/organization-lifecycle";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { roleHasPermission } from "@/lib/authz/policies";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";
import { ORG_ARCHIVE_ACTIVATION_CONFIG_KEY } from "@/lib/organization-archive";
import {
  ORG_DELETE_TIME_RULING,
  type DeleteRuling,
} from "@/lib/org-write/write-registry";

/**
 * Organization DELETE — the reference-guarded transactional core, rebuilt on
 * the org-write kernel (cinatra#1510 / #1939 wave 3, Decision 5).
 *
 * The delete now runs under the kernel's EXCLUSIVE org fence
 * (`guardOrgLifecycleMutation` — BOTH advisory locks in epoch→write order):
 * no epoch transition, no ticket redemption, and no write-only guarded write
 * can interleave with it. Inside that fence the shape is unchanged in spirit —
 * BLOCK-IF-REFERENCED, never cascade — but the blocker inventory is now
 * REBASELINED from the write-registry's `ORG_DELETE_TIME_RULING` single source
 * rather than a hand-coded list, so a new org-axis reference cannot be
 * silently orphaned.
 *
 * Two behavioural changes ship from this wave, in BOTH gate states (disclosed
 * as their own change, separate from the archived-only rollout below):
 *   - ALL installed-extension kinds block the delete (was connectors-only) —
 *     every kind has its own uninstall surface;
 *   - an org with NON-TERMINAL agent runs blocks (a new blocker kind); only
 *     runs in the canonical terminal set (`TERMINAL_RUN_STATUSES`) are history.
 *
 * Archived-only delete (Decision 1), activation-COUPLED: `org.delete` rules
 * "active → deny, archived → allow", but the writer only DEMANDS it once the
 * `org_archive_activation` gate flips (S6) — until then it demands
 * `org.lifecycle` so active-org delete keeps working exactly as the shipped
 * #1928 flow (nothing can be archived yet, so an immediate archived-only flip
 * would brick delete for the whole S3→S6 window). The gate consultation lives
 * in ONE module-private helper (`requiredDeleteCapability`); no caller can pick
 * a door. A gate-read failure REFUSES (fail-closed, distinct `error` result) —
 * a config-store outage pauses deletes rather than guessing.
 *
 * Permission invariant (Decision 1): the delete ALWAYS re-asserts the actor's
 * `organization.delete` permission app-side, independent of which kernel
 * capability is demanded — the kernel capability decides what the ORG STATE
 * permits, `organization.delete` decides what the ACTOR may do; both must
 * pass. `organization.archive` can NEVER stand in for delete (even though the
 * transitional `org.lifecycle` demand maps to it).
 *
 * FK CASCADE companions (schema truth): `role_grant.org_id`,
 * `connector_access_policy.org_id`, and `project_access.principal_org_id`
 * reference `public."organization"(id) ON DELETE CASCADE` — deleting the org
 * row cleans them; no explicit statements needed.
 *
 * Known-inert remainders (retained, disclosed): archived project rows, and the
 * #1928 canonical-history taxonomy (objects / resource / artifact_blobs /
 * change_set / object_change_event) and terminal agent runs — all inert once
 * the org is gone.
 */

export type OrganizationDeleteBlockers = {
  /** Better Auth teams in the org (each has its own manage/delete surface). */
  readonly teams: number;
  /** ACTIVE (non-archived) projects — archived rows are inert history. */
  readonly activeProjects: number;
  /** Installed extensions of ANY kind (#1939: was connectors-only — every kind
   *  carries user-managed config with its own uninstall surface). */
  readonly installedExtensions: number;
  /** Non-default dashboard rows carrying this org (user content; the
   *  entity-anchored default Overview rows are furniture and delete with it). */
  readonly dashboards: number;
  /** Agent templates belonging to the org (`org_id`) or scoped to it (`origin.scope`). */
  readonly agents: number;
  /** Agent runs in a NON-TERMINAL state (#1939: in-flight runs must not be
   *  orphaned; terminal runs are inert history). */
  readonly liveAgentRuns: number;
};

export function hasOrganizationDeleteBlockers(
  blockers: OrganizationDeleteBlockers,
): boolean {
  return (
    blockers.teams > 0 ||
    blockers.activeProjects > 0 ||
    blockers.installedExtensions > 0 ||
    blockers.dashboards > 0 ||
    blockers.agents > 0 ||
    blockers.liveAgentRuns > 0
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
  /** The org must be archived first — the archived-only demand once the
   *  activation gate is on (Decision 1). Unreachable until S6 activation. */
  | { readonly ok: false; readonly reason: "not-archived" }
  | { readonly ok: false; readonly reason: "error"; readonly error: string };

type SqlExecutor = Pick<typeof betterAuthDb, "execute">;

function appSchema(): string {
  return (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll(
    '"',
    '""',
  );
}

/** Block rulings derived from the registry — the single source of the delete
 *  blocker inventory (Decision 5). Object insertion order is stable. */
const BLOCK_RULINGS = Object.values(ORG_DELETE_TIME_RULING).filter(
  (r): r is Extract<DeleteRuling, { kind: "block" }> => r.kind === "block",
);

/** App-schema furniture rulings (the kernel tables org_archive_lease /
 *  org_write_completion_ticket) — deleted in-tx (Decision 5). */
const FURNITURE_RULINGS = Object.values(ORG_DELETE_TIME_RULING).filter(
  (r): r is Extract<DeleteRuling, { kind: "furniture" }> => r.kind === "furniture",
);

/** One block ruling → its `(SELECT count(*) …) AS "<blockerKey>"` fragment,
 *  built from the ruling data so the inventory can never drift from the
 *  registry. The org axis, the optional narrowing predicate, the compound
 *  origin-scope axis (agent_templates), and the non-terminal-run predicate
 *  (from `TERMINAL_RUN_STATUSES`, the run-status single source) are all
 *  derived — never hand-copied. */
function blockCountFragment(
  schema: string,
  organizationId: string,
  ruling: Extract<DeleteRuling, { kind: "block" }>,
): SQL {
  const orgCol = sql.raw(`"${ruling.orgColumn}"`);
  const conditions: SQL[] = [
    ruling.alsoOriginScope
      ? sql`(${orgCol} = ${organizationId} OR origin->>'scope' = ('org:' || ${organizationId}))`
      : sql`${orgCol} = ${organizationId}`,
  ];
  if (ruling.blockWhere) conditions.push(sql.raw(ruling.blockWhere));
  if (ruling.nonTerminalRunsOnly) {
    const terminal = [...TERMINAL_RUN_STATUSES].map((s) => sql`${s}`);
    conditions.push(sql`status NOT IN (${sql.join(terminal, sql`, `)})`);
  }
  return sql`(SELECT count(*)::int FROM "${sql.raw(schema)}"."${sql.raw(ruling.table)}" WHERE ${sql.join(conditions, sql` AND `)}) AS "${sql.raw(ruling.blockerKey)}"`;
}

async function countBlockers(
  db: SqlExecutor,
  organizationId: string,
): Promise<OrganizationDeleteBlockers> {
  const schema = appSchema();
  const fragments: SQL[] = [
    // Better-Auth public table (outside the app-schema declared references).
    sql`(SELECT count(*)::int FROM public."team" WHERE "organizationId" = ${organizationId}) AS "teams"`,
    ...BLOCK_RULINGS.map((r) => blockCountFragment(schema, organizationId, r)),
  ];
  const result = await db.execute<Record<string, string | number>>(
    sql`SELECT ${sql.join(fragments, sql`, `)}`,
  );
  const row = result.rows[0] ?? {};
  return {
    teams: Number(row.teams ?? 0),
    activeProjects: Number(row.activeProjects ?? 0),
    installedExtensions: Number(row.installedExtensions ?? 0),
    dashboards: Number(row.dashboards ?? 0),
    agents: Number(row.agents ?? 0),
    liveAgentRuns: Number(row.liveAgentRuns ?? 0),
  };
}

/**
 * UX pre-count for the danger card ("what's in the way"). Advisory only — the
 * transactional delete re-counts under the org locks; this read is never the
 * authority.
 */
export async function countOrganizationDeleteBlockers(
  organizationId: string,
): Promise<OrganizationDeleteBlockers> {
  return countBlockers(betterAuthDb, organizationId);
}

/** Thrown when the activation-gate read fails — the delete refuses fail-closed
 *  with a distinct `error` result (a config-store outage pauses deletes rather
 *  than guessing archived-vs-active; Decision 1 strict error polarity). */
class DeleteGateReadError extends Error {}

/**
 * Read the SAME `org_archive_activation` gate the archive program owns and
 * decide whether the delete must demand the archived-only capability. Strict
 * three-way polarity (Decision 1): stored literal `true` → TRUE (demand
 * `org.delete`); off/absent → FALSE (demand `org.lifecycle`, active delete
 * keeps working); any READ ERROR → throw (refuse both active and archived
 * delete) — the mirror of the archive stub's fail-closed OFF.
 */
async function deleteRequiresArchivedState(): Promise<boolean> {
  try {
    const { readConnectorConfigFromDatabase } = await import("@/lib/database");
    const cfg = readConnectorConfigFromDatabase<{ enabled?: boolean } | null>(
      ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
      null,
    );
    return cfg?.enabled === true;
  } catch (err) {
    throw new DeleteGateReadError(
      `org_archive_activation gate read failed; refusing delete fail-closed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** The kernel capability the delete writer demands right now (module-private —
 *  the switch is NOT API surface; no caller can pick a door). `org.delete`
 *  once archiving activates, `org.lifecycle` (transitional) until then. */
async function requiredDeleteCapability(): Promise<OrgWriteCapability> {
  return (await deleteRequiresArchivedState()) ? "org.delete" : "org.lifecycle";
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
 * Delete the organization if — and only if — nothing blocks it, under the
 * kernel's exclusive org fence (`guardOrgLifecycleMutation`: both advisory
 * locks, epoch→write). The pre-tx fence (single-org / default / not-found) and
 * the app-side `organization.delete` re-assert run BEFORE any authority is
 * minted; the kernel then rules the demanded capability against the org's
 * lifecycle state under the locks; inside the fence the FOR UPDATE row pin +
 * slug/owner re-verify + registry-derived blocker re-count + furniture deletes
 * + the org-row delete (exact-rowcount assertion) run as ONE transaction. Any
 * blocker, missing row, or assertion failure rolls the whole transaction back.
 *
 * The caller (the server action) owns the first AUTHORIZATION check (viewed-org
 * catalog gate) and the name-confirmation; this module owns the data-integrity
 * guards AND re-verifies both structural hazards and the actor's owner
 * membership at delete time.
 */
export async function deleteOrganizationReferenceGuarded(
  organizationId: string,
  actorUserId: string,
): Promise<OrganizationDeleteResult> {
  const schema = appSchema();
  // Hoisted so the catch can map the kernel's capability-denied refusal to
  // "not-archived" ONLY when the archived-only demand (org.delete) was the one
  // refused — never a future org.lifecycle deny cell (codex r0 nit, defensive).
  let demandedCapability: OrgWriteCapability | undefined;
  try {
    // Structural pre-tx fence (hazard 3) via the shared lifecycle primitive
    // (cinatra#1937): single-org mode, default org, missing row — fail-closed.
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

    // Decision 1 permission invariant — re-assert the actor's
    // `organization.delete` BEFORE minting/using any authority, independent of
    // which kernel capability the gate makes the writer demand. An actor
    // holding only `organization.archive` can NEVER delete (in either gate
    // state): the resolved-role → authority mint below maps org.delete to
    // organization.delete, NEVER organization.archive.
    const role = await resolveOrgRoleForUser(organizationId, actorUserId);
    if (role === undefined || !roleHasPermission(role, "organization.delete")) {
      return { ok: false, reason: "denied" };
    }
    const authority = sessionAuthorityFromResolvedRole(organizationId, role);

    // Activation-coupled capability selection (module-private; strict error
    // polarity). A gate-read failure throws → mapped to a distinct `error`.
    const capability = await requiredDeleteCapability();
    demandedCapability = capability;

    await guardOrgLifecycleMutation(
      betterAuthDb as unknown as OrgWriteDb<OrgWriteTx>,
      { orgId: organizationId, capability, authority },
      async (rawTx) => {
        const tx = rawTx as unknown as SqlExecutor;
        // FOR UPDATE org-row pin — now AFTER the advisory locks (the kernel's
        // locked FOR SHARE state read already ran; this pins the row + reads the
        // slug for the in-tx default-org re-check, hazard 1).
        const locked = await tx.execute<{ id: string; slug: string | null }>(sql`
          SELECT id, slug FROM public."organization"
          WHERE id = ${organizationId}
          FOR UPDATE
        `);
        const org = locked.rows[0];
        if (!org) throw new DeleteNotFoundError();
        if (org.slug === "default") throw new DeleteDefaultOrgError();

        // In-tx authz re-verify: the actor must STILL be an owner (member.role
        // = 'owner' is exactly what the gate maps to org_owner). A demotion /
        // removal racing the capability read rolls the delete back.
        const ownerRow = await tx.execute(sql`
          SELECT 1 AS is_owner FROM public."member"
          WHERE "organizationId" = ${organizationId}
            AND "userId" = ${actorUserId}
            AND role = 'owner'
          LIMIT 1
        `);
        if (ownerRow.rows.length === 0) throw new DeleteDeniedError();

        // Blockers re-counted UNDER the locks (the pre-count is UX only).
        const blockers = await countBlockers(tx, organizationId);
        if (hasOrganizationDeleteBlockers(blockers)) {
          throw new DeleteBlockedError(blockers);
        }

        // Furniture — the entity-anchored default Overview dashboard rows
        // (unchanged; the non-default rows are the `dashboards` blocker above).
        await tx.execute(sql`
          DELETE FROM "${sql.raw(schema)}"."dashboards"
          WHERE organization_id = ${organizationId} AND is_default = true
        `);
        // App-schema kernel-table furniture (org_archive_lease /
        // org_write_completion_ticket) — derived from the ruling record.
        for (const furniture of FURNITURE_RULINGS) {
          await tx.execute(sql`
            DELETE FROM "${sql.raw(schema)}"."${sql.raw(furniture.table)}"
            WHERE "${sql.raw(furniture.orgColumn)}" = ${organizationId}
          `);
        }
        // Better-Auth furniture rows.
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
    if (err instanceof DeleteGateReadError) {
      return { ok: false, reason: "error", error: err.message };
    }
    if (err instanceof OrgWriteRefusedError) {
      // The kernel ruling refused. The ONLY deny cell for the delete writer is
      // org.delete × active (gate on, org still active) → "archive first"; the
      // capability guard makes it regression-proof (a future org.lifecycle deny
      // cell would NOT masquerade as not-archived). organization-not-found is
      // the race backstop; authority refusals cannot occur post the app-side
      // re-assert but map to denied defensively.
      if (err.reason === "capability-denied" && demandedCapability === "org.delete") {
        return { ok: false, reason: "not-archived" };
      }
      if (err.reason === "organization-not-found") {
        return { ok: false, reason: "not-found" };
      }
      return { ok: false, reason: "denied" };
    }
    const message =
      err instanceof Error && err.message ? err.message : "delete failed";
    return { ok: false, reason: "error", error: message };
  }
}
