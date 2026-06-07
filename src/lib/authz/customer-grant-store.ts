/**
 * Customer / external grant store.
 *
 * A customer grant is PROJECT-scoped: the project is the bounded space holding
 * the specific chat threads / agents / info pages a customer may reach.
 * Inviting a customer writes two rows:
 *
 *   1. role_grant(role="customer", scopeLevel="project", scopeRecordId,
 *      expiresAt) — the read-mostly capability ceiling + expiry. Flows into
 *      actor.roles[] via resolveEffectiveRoleNamesForUser.
 *   2. project_access(principal_level="user", role="read") — the sealed-room
 *      visibility so the customer can actually see the project's resources.
 *      Flows into actor.projectGrants[] via readProjectGrantsForUser.
 *
 * Revoking removes both. Cross-customer isolation is structural: grants are
 * keyed per (subjectUserId, projectId); one customer never sees another's
 * grants (the management list is project-admin-only).
 */
import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { roleGrant } from "./role-grant-schema";

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgres://localhost" });
  }
  return _pool;
}
function db() {
  return drizzle(pool());
}

function schemaName(): string {
  return (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
}

export type CustomerGrantRow = {
  subjectUserId: string;
  projectId: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt: Date | null;
};

/**
 * Invite (or refresh) a customer's project-scoped access. Idempotent — both
 * writes upsert.
 */
export async function grantCustomerAccess(input: {
  subjectUserId: string;
  projectId: string;
  orgId: string;
  grantedBy: string;
  expiresAt?: Date | null;
}): Promise<void> {
  const now = new Date();
  // 1. role_grant — the customer capability ceiling + expiry.
  await db()
    .insert(roleGrant)
    .values({
      subjectUserId: input.subjectUserId,
      role: "customer",
      scopeLevel: "project",
      scopeRecordId: input.projectId,
      orgId: input.orgId,
      grantedBy: input.grantedBy,
      grantedAt: now,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [roleGrant.subjectUserId, roleGrant.role, roleGrant.scopeLevel, roleGrant.scopeRecordId],
      set: { grantedBy: input.grantedBy, grantedAt: now, expiresAt: input.expiresAt ?? null },
    });
  // 2. project_access read — sealed-room visibility.
  await db().execute(sql`
    INSERT INTO "${sql.raw(schemaName())}"."project_access"
      (project_id, principal_level, principal_id, role, granted_by)
    VALUES (${input.projectId}, 'user', ${input.subjectUserId}, 'read', ${input.grantedBy})
    ON CONFLICT (project_id, principal_level, principal_id)
      DO UPDATE SET role = 'read'
  `);
}

/** Revoke a customer's project-scoped access — removes both rows. */
export async function revokeCustomerAccess(input: {
  subjectUserId: string;
  projectId: string;
}): Promise<{ revoked: boolean }> {
  const removed = await db()
    .delete(roleGrant)
    .where(
      and(
        eq(roleGrant.subjectUserId, input.subjectUserId),
        eq(roleGrant.role, "customer"),
        eq(roleGrant.scopeLevel, "project"),
        eq(roleGrant.scopeRecordId, input.projectId),
      ),
    )
    .returning({ subjectUserId: roleGrant.subjectUserId });
  await db().execute(sql`
    DELETE FROM "${sql.raw(schemaName())}"."project_access"
     WHERE project_id = ${input.projectId}
       AND principal_level = 'user'
       AND principal_id = ${input.subjectUserId}
  `);
  return { revoked: removed.length > 0 };
}

/** List a project's customer grants (project-admin surface). */
export async function listCustomerGrantsForProject(projectId: string): Promise<CustomerGrantRow[]> {
  const rows = await db()
    .select()
    .from(roleGrant)
    .where(
      and(
        eq(roleGrant.role, "customer"),
        eq(roleGrant.scopeLevel, "project"),
        eq(roleGrant.scopeRecordId, projectId),
      ),
    );
  return rows.map((r) => ({
    subjectUserId: r.subjectUserId,
    projectId: r.scopeRecordId,
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
  }));
}
