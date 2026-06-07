/**
 * Project-scoped agent access bridge.
 *
 * Agents (templates) are ambient — they have no `project_id` column. They
 * are pinned to projects via the `project_agent_template_bindings` join
 * table. This helper is an ADDITIVE access source: an actor who holds a
 * `project_access` grant on ANY project the agent template is bound to gains
 * access to that agent — WITHOUT changing the agent's ownership tier.
 *
 * It is purely additive: callers consult it only AFTER the ownership-based
 * authz (enforceRunAccess / enforceResourceAccess) denies. A grant here can
 * never REMOVE access the owner already has.
 */
import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

import type { ProjectGrant } from "./actor-context";

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

export type AgentProjectAccessDecision =
  | { granted: true; viaProjectId: string; role: ProjectGrant["effectiveRole"] }
  | { granted: false };

/**
 * Resolve whether `actor` reaches agent template `templateId` via a
 * project_access grant on a project the template is bound to.
 *
 * `minRole` — the minimum effective project role required. Defaults to
 * "read" (visibility); pass "write" for run/execute access.
 */
export async function resolveAgentProjectAccess(
  templateId: string,
  actor: { projectGrants?: Array<Pick<ProjectGrant, "projectId" | "effectiveRole">> },
  opts: { minRole?: ProjectGrant["effectiveRole"] } = {},
): Promise<AgentProjectAccessDecision> {
  const grants = actor.projectGrants ?? [];
  if (grants.length === 0) return { granted: false };

  const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll('"', '""');
  let boundProjectIds: string[];
  try {
    const result = await db().execute<{ project_id: string; visibility: string }>(sql`
      SELECT project_id, visibility
        FROM "${sql.raw(schema)}"."project_agent_template_bindings"
       WHERE agent_template_id = ${templateId}
    `);
    // "hidden" bindings are pinned-but-not-surfaced; they still grant access
    // when explicitly invoked. "project-private" + "visible" both grant.
    boundProjectIds = result.rows.map((r) => r.project_id);
  } catch {
    // Bindings table absent on a legacy schema → no project-scoped access.
    return { granted: false };
  }
  if (boundProjectIds.length === 0) return { granted: false };

  const minRole = opts.minRole ?? "read";
  const rank: Record<ProjectGrant["effectiveRole"], number> = { read: 1, write: 2, admin: 3, owner: 4 };
  const need = rank[minRole];

  const boundSet = new Set(boundProjectIds);
  for (const g of grants) {
    if (boundSet.has(g.projectId) && rank[g.effectiveRole] >= need) {
      return { granted: true, viaProjectId: g.projectId, role: g.effectiveRole };
    }
  }
  return { granted: false };
}
