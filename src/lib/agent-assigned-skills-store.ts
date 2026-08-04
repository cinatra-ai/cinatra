import "server-only";

// ---------------------------------------------------------------------------
// `agent_assigned_skills` DB primitives (cinatra#2346 S1, epic #2345).
//
// The store half of direct skill assignment. Async pooled access (the
// architecture's default for request-time persistence), because the cap needs a
// MULTI-statement transaction: its `pg_advisory_xact_lock` is transaction-
// scoped, and count → next-position → insert must be one atomic section.
//
// WHY A LOCK AT ALL. A plain "count, then insert if under the cap" is NOT
// race-safe under READ COMMITTED: two concurrent requests both read 2, both
// decide they may insert, and the agent ends up with 4 assignments. Serializing
// per agent closes it. The UNIQUE (agent_package_name, "position") index is the
// second line of defense — two racers that somehow computed the same next
// position cannot both land.
//
// LOCK ORDERING (issue scope item 3) — the ACTION owns the outer lock, this
// store owns the inner one, and the order is fixed:
//
//   1. the owning SKILL extension's lifecycle lock (`withInstallLock`, which
//      itself takes the global extension-lifecycle lock first) + a revalidation
//      of assignability WHILE HOLDING IT — this is what closes the
//      assign-vs-uninstall race; the cap lock alone only serializes competing
//      assignments against each other;
//   2. the per-agent advisory TRANSACTION lock (here);
//   3. count → position → insert (here).
//
// The order is never inverted: the lifecycle lock is a process-level async lock
// and the advisory lock is a DB lock held only for the length of one short
// transaction, so a lifecycle operation never waits behind a DB lock held by
// something waiting for the lifecycle lock.
// ---------------------------------------------------------------------------

import { getPooledDb } from "@/lib/db/pooled";
import { AGENT_ASSIGNED_SKILLS_TABLE } from "@/lib/skill-lifecycle-schema";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/**
 * Maximum directly-assigned skills per agent package (epic: "max 3").
 * The floor is 0 — unlike extension owners, the last assignment may be removed.
 */
export const AGENT_ASSIGNED_SKILLS_CAP = 3;

/** The advisory-lock namespace, so the per-agent key cannot collide with any
 *  other subsystem's `hashtextextended` key space. */
const ADVISORY_LOCK_NAMESPACE = "agent_assigned_skills";

export type AgentAssignedSkillRow = {
  agentPackageName: string;
  skillId: string;
  position: number;
  createdBy: string;
  createdAt: string;
};

export type AssignedSkillsQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

/** Runs `fn` inside ONE transaction (the xact-scoped advisory lock plus the
 *  multi-statement count/position/insert need it). Tests inject a pass-through
 *  over the query double; the default BEGIN/COMMITs on a pooled client. */
export type AssignedSkillsTransaction = <T>(
  fn: (txQuery: AssignedSkillsQuery) => Promise<T>,
) => Promise<T>;

export type AssignedSkillsStoreDeps = {
  query?: AssignedSkillsQuery;
  transaction?: AssignedSkillsTransaction;
  schema?: string;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "agent-assigned-skills" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function defaultTransaction<T>(
  fn: (txQuery: AssignedSkillsQuery) => Promise<T>,
): Promise<T> {
  const pool = await getPooledDb({ name: "agent-assigned-skills" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txQuery: AssignedSkillsQuery = async <U = unknown>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query(text, values ? [...values] : undefined);
      return result.rows as U[];
    };
    const out = await fn(txQuery);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the one worth surfacing */
    }
    throw err;
  } finally {
    client.release();
  }
}

function passthroughTransaction(query: AssignedSkillsQuery): AssignedSkillsTransaction {
  return async (fn) => fn(query);
}

function resolveDeps(deps?: AssignedSkillsStoreDeps): {
  query: AssignedSkillsQuery;
  transaction: AssignedSkillsTransaction;
  table: string;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quoted
  // defensively all the same.
  const table = `"${schema.replaceAll('"', '""')}"."${AGENT_ASSIGNED_SKILLS_TABLE}"`;
  const query = deps?.query ?? defaultQuery;
  const transaction =
    deps?.transaction ?? (deps?.query ? passthroughTransaction(deps.query) : defaultTransaction);
  return { query, transaction, table };
}

type RawRow = {
  agent_package_name: string;
  skill_id: string;
  position: number | string;
  created_by: string;
  created_at: string | Date;
};

function toRow(raw: RawRow): AgentAssignedSkillRow {
  return {
    agentPackageName: raw.agent_package_name,
    skillId: raw.skill_id,
    position: Number(raw.position),
    createdBy: raw.created_by,
    createdAt:
      raw.created_at instanceof Date ? raw.created_at.toISOString() : String(raw.created_at),
  };
}

/**
 * The ordered assignment rows for ONE canonical agent package.
 *
 * ACTOR-INDEPENDENT by construction — no owner predicate, no principal, no org.
 * That is the whole point of the table: an actor-less worker run reads exactly
 * what the settings page wrote.
 */
export async function readAssignedSkillsForAgentPackage(
  agentPackageName: string,
  deps?: AssignedSkillsStoreDeps,
): Promise<AgentAssignedSkillRow[]> {
  const { query, table } = resolveDeps(deps);
  if (!agentPackageName) return [];
  const rows = await query<RawRow>(
    `SELECT agent_package_name, skill_id, "position", created_by, created_at
       FROM ${table}
      WHERE agent_package_name = $1
      ORDER BY "position" ASC`,
    [agentPackageName],
  );
  return rows.map(toRow);
}

export type InsertAssignedSkillResult =
  | { outcome: "assigned"; row: AgentAssignedSkillRow }
  | { outcome: "already_assigned"; row: AgentAssignedSkillRow }
  | { outcome: "cap_exceeded"; count: number };

/**
 * The ATOMIC cap-guarded insert: ONE transaction, serialized per agent package.
 *
 *   advisory lock → idempotent re-check → cap count → next position → insert
 *
 * An already-assigned pair returns `already_assigned` (idempotent re-submit)
 * WITHOUT consuming a cap slot. A racer that lost the PK arbiter re-selects the
 * winner's row rather than reporting a spurious failure.
 *
 * The caller MUST already hold the owning skill extension's lifecycle lock and
 * must have revalidated assignability under it — this function deliberately
 * knows nothing about skills, only about the cap and the ordering.
 */
export async function insertAssignedSkill(
  input: { agentPackageName: string; skillId: string; createdBy: string },
  deps?: AssignedSkillsStoreDeps,
): Promise<InsertAssignedSkillResult> {
  const { transaction, table } = resolveDeps(deps);
  return transaction(async (tx) => {
    // (1) Serialize the whole section per agent package. Namespaced so the key
    // space cannot collide with another subsystem's advisory locks.
    await tx(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
      ADVISORY_LOCK_NAMESPACE,
      input.agentPackageName,
    ]);

    // (2) Idempotent re-check under the lock: a duplicate assign is a no-op
    // that must NOT consume (or be refused by) a cap slot.
    const existing = await tx<RawRow>(
      `SELECT agent_package_name, skill_id, "position", created_by, created_at
         FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2`,
      [input.agentPackageName, input.skillId],
    );
    if (existing[0]) return { outcome: "already_assigned", row: toRow(existing[0]) } as const;

    // (3) Cap check under the lock.
    const counted = await tx<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE agent_package_name = $1`,
      [input.agentPackageName],
    );
    const count = Number(counted[0]?.n ?? 0);
    if (count >= AGENT_ASSIGNED_SKILLS_CAP) return { outcome: "cap_exceeded", count } as const;

    // (4) Next position + insert in ONE statement, so the value cannot drift
    // between reading and writing it. `COALESCE(MAX+1, 1)` keeps insertion
    // order stable across removals (positions may go sparse; ordering is what
    // matters, not density). The PK arbiter collapses a racer to DO NOTHING.
    const inserted = await tx<RawRow>(
      `INSERT INTO ${table} (agent_package_name, skill_id, "position", created_by)
       SELECT $1, $2, COALESCE(MAX("position"), 0) + 1, $3 FROM ${table} WHERE agent_package_name = $1
       ON CONFLICT (agent_package_name, skill_id) DO NOTHING
       RETURNING agent_package_name, skill_id, "position", created_by, created_at`,
      [input.agentPackageName, input.skillId, input.createdBy],
    );
    if (inserted[0]) return { outcome: "assigned", row: toRow(inserted[0]) } as const;

    // A racer won the PK arbiter while we held the lock (only reachable when a
    // caller bypasses the transaction seam); report the winner, never a lie.
    const winner = await tx<RawRow>(
      `SELECT agent_package_name, skill_id, "position", created_by, created_at
         FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2`,
      [input.agentPackageName, input.skillId],
    );
    if (winner[0]) return { outcome: "already_assigned", row: toRow(winner[0]) } as const;
    throw new Error(
      "insertAssignedSkill: insert produced no row and no existing row under the advisory lock",
    );
  });
}

/**
 * Remove ONE assignment. Idempotent: removing a row that is already gone
 * reports `deleted: false` rather than throwing — the UI's remove button and a
 * completed uninstall teardown can both have run.
 *
 * There is NO minimum: removal works all the way down to zero rows (unlike
 * extension owners, where one owner must remain).
 */
export async function deleteAssignedSkill(
  input: { agentPackageName: string; skillId: string },
  deps?: AssignedSkillsStoreDeps,
): Promise<{ deleted: boolean }> {
  const { query, table } = resolveDeps(deps);
  const rows = await query<{ skill_id: string }>(
    `DELETE FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2 RETURNING skill_id`,
    [input.agentPackageName, input.skillId],
  );
  return { deleted: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// LIFECYCLE TEARDOWN primitives (cinatra#2350 S5, epic #2345).
//
// Uninstalling either side of an assignment deletes the row. `created_by` /
// `created_at` are CONFIGURATION metadata on a live row, not a post-uninstall
// audit trail (the S1 decision, recorded in `skill-lifecycle-schema.ts`), so a
// completed uninstall leaves nothing behind. Retaining the row would be an
// ORPHAN-REAPPLY hazard, not an audit record: reinstalling the same package
// re-derives the same catalog skill ids, the S2 resolution-time revalidation
// would start passing again, and delivery would silently resume from a
// configuration nobody re-made. Both writers therefore report WHAT they removed
// so the caller can log it, and both are idempotent — a second teardown of the
// same package removes nothing and says so.
// ---------------------------------------------------------------------------

/** ONE removed pair, reported back so a teardown can log what it swept. */
export type RemovedAssignedSkill = { agentPackageName: string; skillId: string };

/**
 * SKILL-side teardown: delete every assignment naming any of these catalog
 * skill ids, across ALL agents.
 *
 * The ids must be the EXACT derived catalog ids of the package being
 * uninstalled (`deriveSkillRegistration`, virtual chat namespace included) —
 * this store deliberately knows nothing about derivation, only about rows.
 */
export async function deleteAssignedSkillsForSkillIds(
  skillIds: readonly string[],
  deps?: AssignedSkillsStoreDeps,
): Promise<{ removed: RemovedAssignedSkill[] }> {
  const { query, table } = resolveDeps(deps);
  const ids = [...new Set(skillIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { removed: [] };
  const rows = await query<{ agent_package_name: string; skill_id: string }>(
    `DELETE FROM ${table} WHERE skill_id = ANY($1::text[])
     RETURNING agent_package_name, skill_id`,
    [ids],
  );
  return {
    removed: rows.map((r) => ({ agentPackageName: r.agent_package_name, skillId: r.skill_id })),
  };
}

/**
 * AGENT-side teardown: delete every assignment this agent package carries.
 *
 * Keyed on the canonical agent package name — the same key the assign path
 * writes (`agent_templates.package_name`, which is what `ref.packageName` is at
 * the uninstall call site).
 */
export async function deleteAssignedSkillsForAgentPackage(
  agentPackageName: string,
  deps?: AssignedSkillsStoreDeps,
): Promise<{ removed: RemovedAssignedSkill[] }> {
  const { query, table } = resolveDeps(deps);
  if (!agentPackageName) return { removed: [] };
  const rows = await query<{ skill_id: string }>(
    `DELETE FROM ${table} WHERE agent_package_name = $1 RETURNING skill_id`,
    [agentPackageName],
  );
  return { removed: rows.map((r) => ({ agentPackageName, skillId: r.skill_id })) };
}
