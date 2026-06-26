/**
 * `role_grant` store.
 *
 * CRUD + resolver for per-scope role grants. The CRUD surface is exposed
 * via MCP primitives (`role_grant_grant` / `_revoke` / `_list`); the
 * resolver `readRoleGrantsForUser` is consumed by the existing session →
 * ActorContext bridges (projects/registry.ts, dashboards, lists, agents)
 * so the kernel sees the user's effective roles at every authz decision.
 *
 * Subject is always a user; no agent principals.
 */
import "server-only";

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getPooledDb, failOpenLocalhost } from "@/lib/db/pooled";
import { roleGrant, type RoleGrantInsert, type RoleGrantRow } from "./role-grant-schema";

// Lazy pool over the shared pool (@/lib/db/pooled, #303). This authz resolver
// historically fails OPEN to a local placeholder DSN so import-time evaluation
// never throws even outside a configured environment; `failOpenLocalhost`
// preserves that exact behavior (the connection is still lazy and never opened
// until the first query).
function db() {
  return drizzle(getPooledDb({ name: "role-grant-store", connectionString: failOpenLocalhost }));
}

export type RoleGrantScope =
  | { level: "user"; recordId: string }
  | { level: "team"; recordId: string }
  | { level: "organization"; recordId: string }
  | { level: "workspace"; recordId: string }
  | { level: "project"; recordId: string };

export type V61Role = "developer" | "release_manager" | "customer";

/**
 * Idempotent grant: re-granting the same (subject, role, scope) returns
 * the existing row updated with the new `granted_by` + `granted_at`.
 */
export async function grantRole(input: {
  subjectUserId: string;
  role: V61Role;
  scope: RoleGrantScope;
  orgId: string;
  grantedBy: string;
  expiresAt?: Date | null;
}): Promise<RoleGrantRow> {
  const values: RoleGrantInsert = {
    subjectUserId: input.subjectUserId,
    role: input.role,
    scopeLevel: input.scope.level,
    scopeRecordId: input.scope.recordId,
    orgId: input.orgId,
    grantedBy: input.grantedBy,
    grantedAt: new Date(),
    expiresAt: input.expiresAt ?? null,
  };
  const [row] = await db()
    .insert(roleGrant)
    .values(values)
    .onConflictDoUpdate({
      target: [roleGrant.subjectUserId, roleGrant.role, roleGrant.scopeLevel, roleGrant.scopeRecordId],
      set: { grantedBy: values.grantedBy, grantedAt: values.grantedAt, expiresAt: values.expiresAt },
    })
    .returning();
  return row;
}

export async function revokeRole(input: {
  subjectUserId: string;
  role: V61Role;
  scope: RoleGrantScope;
}): Promise<{ revoked: boolean }> {
  const result = await db()
    .delete(roleGrant)
    .where(
      and(
        eq(roleGrant.subjectUserId, input.subjectUserId),
        eq(roleGrant.role, input.role),
        eq(roleGrant.scopeLevel, input.scope.level),
        eq(roleGrant.scopeRecordId, input.scope.recordId),
      ),
    )
    .returning({ subjectUserId: roleGrant.subjectUserId });
  return { revoked: result.length > 0 };
}

/**
 * Resolve a user's currently-effective role names for use in the kernel's
 * `actor.roles[]` axis. Filters by org + expired-at; returns the unique
 * set of role names (any scope where the user holds the role).
 *
 * Scope-aware resolution belongs in per-resource resolvers (e.g. customer
 * role only grants on the specific resource the role-grant points at).
 * This helper returns the effective grant rows without target-resource
 * narrowing.
 */
export async function readRoleGrantsForUser(
  userId: string,
  orgId: string,
): Promise<RoleGrantRow[]> {
  const now = new Date();
  return await db()
    .select()
    .from(roleGrant)
    .where(
      and(
        eq(roleGrant.subjectUserId, userId),
        eq(roleGrant.orgId, orgId),
        or(isNull(roleGrant.expiresAt), gt(roleGrant.expiresAt, now)),
      ),
    );
}

/**
 * List all grants for an org (admin surface). No filter — caller is
 * responsible for upstream authz.
 */
export async function listRoleGrantsForOrg(orgId: string): Promise<RoleGrantRow[]> {
  return await db().select().from(roleGrant).where(eq(roleGrant.orgId, orgId));
}

/**
 * Resolve a user's effective role NAMES for the kernel — distinct
 * `(role)` keys ignoring scope. Callers that need target-resource checks
 * can use the grant rows to scope-narrow per-resource.
 */
export async function resolveEffectiveRoleNamesForUser(
  userId: string,
  orgId: string,
): Promise<V61Role[]> {
  const rows = await readRoleGrantsForUser(userId, orgId);
  return [...new Set(rows.map((r) => r.role as V61Role))];
}
