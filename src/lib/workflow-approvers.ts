import "server-only";

// Host-side approver resolution for release-workflow approval gates. The
// release-workflows package is auth-agnostic (a leaf); the host owns the
// better-auth membership tables, so resolution lives here and is injected as
// the `approverResolvable` probe (instantiate + start-time re-auth) and used
// by the notifier to route `approval_needed` to concrete recipients.

import { sql } from "drizzle-orm";
import { betterAuthDb } from "@/lib/better-auth-db";

/** Approval scope as authored on an approval task (mirror of approvalScopeSchema). */
export type ApprovalScope = { level?: string; id?: string } | null | undefined;

function dedupe(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((x): x is string => Boolean(x)))];
}

/**
 * Resolve an approval scope to the concrete user IDs allowed to decide it:
 *  - `user`         → the named user (scope.id).
 *  - `team`         → every member of the team (scope.id), via public."teamMember".
 *  - `organization` → the org's OWNERS + ADMINS only (not all members), via
 *                     public.member; falls back to the workflow's org when no id.
 *  - `workspace`    → platform admins (public."user".role contains "admin").
 * Returns [] for an unresolvable scope (missing id, unknown level).
 */
export async function resolveWorkflowApprovers(scope: ApprovalScope, orgId: string): Promise<string[]> {
  const level = scope?.level;
  const id = scope?.id;
  switch (level) {
    case "user": {
      // Cross-tenant guard: the named user must belong to the workflow's org,
      // else a workflow in org A could be approvable by a user from org B.
      if (!id) return [];
      const r = await betterAuthDb.execute<{ userId: string }>(sql`
        SELECT m."userId" AS "userId" FROM public.member m
        WHERE m."userId" = ${id} AND m."organizationId" = ${orgId} LIMIT 1
      `);
      return r.rows.length > 0 ? [id] : [];
    }
    case "team": {
      // The team must belong to the workflow's org (cross-tenant guard).
      if (!id) return [];
      const r = await betterAuthDb.execute<{ userId: string }>(sql`
        SELECT tm."userId" AS "userId" FROM public."teamMember" tm
        JOIN public."team" t ON t.id = tm."teamId"
        WHERE tm."teamId" = ${id} AND t."organizationId" = ${orgId}
      `);
      return dedupe(r.rows.map((x) => x.userId));
    }
    case "organization": {
      // Only the workflow's OWN org — a foreign org id is never resolvable.
      if (id && id !== orgId) return [];
      const targetOrg = orgId;
      if (!targetOrg) return [];
      const admins = await betterAuthDb.execute<{ userId: string }>(sql`
        SELECT m."userId" AS "userId" FROM public.member m
        WHERE m."organizationId" = ${targetOrg} AND m.role IN ('owner', 'admin')
      `);
      const adminIds = dedupe(admins.rows.map((x) => x.userId));
      if (adminIds.length > 0) return adminIds;
      // Fallback: an org with no owner/admin (e.g. roles never assigned) would
      // otherwise make every org-scoped approval unresolvable → un-startable.
      // Resolve to all members so the approval can still be acted on.
      const members = await betterAuthDb.execute<{ userId: string }>(sql`
        SELECT m."userId" AS "userId" FROM public.member m WHERE m."organizationId" = ${targetOrg}
      `);
      return dedupe(members.rows.map((x) => x.userId));
    }
    case "workspace": {
      // Platform admins — public."user".role is a comma-separated list that
      // includes "admin" (mirrors isPlatformAdmin's split semantics).
      const r = await betterAuthDb.execute<{ id: string }>(sql`
        SELECT u.id AS id FROM public."user" u
        WHERE u.role IS NOT NULL
          AND 'admin' = ANY(string_to_array(regexp_replace(u.role, '\s', '', 'g'), ','))
      `);
      return dedupe(r.rows.map((x) => x.id));
    }
    default:
      return [];
  }
}

/**
 * Re-auth predicate (instantiate + start-time): can this approval scope resolve
 * to at least one concrete approver in `orgId`? A workflow can never start with
 * an unresolvable approver scope.
 */
export async function approverResolvable(scope: ApprovalScope, orgId: string): Promise<boolean> {
  return (await resolveWorkflowApprovers(scope, orgId)).length > 0;
}
