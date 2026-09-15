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
//   2. the per-(agent package, EXACT SCOPE) advisory TRANSACTION lock (here);
//   3. count → position → insert (here).
//
// The order is never inverted: the lifecycle lock is a process-level async lock
// and the advisory lock is a DB lock held only for the length of one short
// transaction, so a lifecycle operation never waits behind a DB lock held by
// something waiting for the lifecycle lock.
// ---------------------------------------------------------------------------

import { getPooledDb } from "@/lib/db/pooled";
import { AGENT_ASSIGNED_SKILLS_TABLE } from "@/lib/skill-lifecycle-schema";
import {
  WORKSPACE_SCOPE_SENTINEL,
  assertAssignmentScope,
  assignmentScopeLockKey,
  type AssignmentScope,
  type AssignmentSource,
} from "@/lib/assignment-scope";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/**
 * Maximum directly-assigned skills per agent package PER EXACT SCOPE
 * (cinatra#2813 S1, epic #2812: "5 per (agent package, exact scope)").
 *
 * The floor is 0 — unlike extension owners, the last assignment may be
 * removed. The cap counts ONE scope tuple, not the package: five at project
 * scope and five at organization scope are both legal, and the number that
 * actually reaches a run is a separate, narrower question the delivery chain
 * answers under the injection ceiling.
 */
export const AGENT_ASSIGNED_SKILLS_CAP = 5;

/** The tuple a caller that has no scope of its own writes at.
 *
 *  Package-global assignment is what the workspace tier means, so the
 *  pre-scope callers keep writing exactly the rows they always wrote. */
export const WORKSPACE_ASSIGNMENT_SCOPE: AssignmentScope = Object.freeze({
  scopeKind: "workspace",
  scopeId: WORKSPACE_SCOPE_SENTINEL,
});

/** The advisory-lock namespace, so the per-(package, scope) key cannot collide
 *  with any other subsystem's `hashtextextended` key space. The key itself is
 *  composed by the shared scope module, so this store and the context store
 *  cannot drift on what "one scope" means. */
const ADVISORY_LOCK_NAMESPACE = "agent_assigned_skills";

export type AgentAssignedSkillRow = {
  agentPackageName: string;
  skillId: string;
  scopeKind: AssignmentScope["scopeKind"];
  scopeId: string;
  source: AssignmentSource;
  /** The run an accepted recommendation came from. Forward-looking, and a
   *  POINTER: deleting the run nulls this and keeps the assignment. */
  originRunId: string | null;
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
  scope_kind: string;
  scope_id: string;
  source: string;
  origin_run_id: string | null;
  position: number | string;
  created_by: string;
  created_at: string | Date;
};

/** The column list, written once so every statement selects the same shape. */
const COLUMNS =
  'agent_package_name, skill_id, scope_kind, scope_id, source, origin_run_id, "position", created_by, created_at';

function toRow(raw: RawRow): AgentAssignedSkillRow {
  return {
    agentPackageName: raw.agent_package_name,
    skillId: raw.skill_id,
    scopeKind: raw.scope_kind as AssignmentScope["scopeKind"],
    scopeId: raw.scope_id,
    source: (raw.source === "recommended" ? "recommended" : "manual") as AssignmentSource,
    originRunId: raw.origin_run_id ?? null,
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
    `SELECT ${COLUMNS}
       FROM ${table}
      WHERE agent_package_name = $1
      ORDER BY scope_kind ASC, scope_id ASC, "position" ASC`,
    [agentPackageName],
  );
  return rows.map(toRow);
}

/**
 * The ordered assignment rows for ONE agent package at ONE EXACT scope.
 *
 * The narrow read the per-scope surfaces use. It is a separate function rather
 * than an optional argument on the package-wide read because the two answer
 * genuinely different questions — "everything this agent carries anywhere" and
 * "what this scope assigned" — and a caller that passed the wrong argument
 * would get a plausible, wrong answer instead of a type error.
 */
export async function readAssignedSkillsForAgentScope(
  agentPackageName: string,
  scope: { scopeKind: string; scopeId: string },
  deps?: AssignedSkillsStoreDeps,
): Promise<AgentAssignedSkillRow[]> {
  const { query, table } = resolveDeps(deps);
  if (!agentPackageName) return [];
  const valid = assertAssignmentScope(scope);
  const rows = await query<RawRow>(
    `SELECT ${COLUMNS}
       FROM ${table}
      WHERE agent_package_name = $1 AND scope_kind = $2 AND scope_id = $3
      ORDER BY "position" ASC`,
    [agentPackageName, valid.scopeKind, valid.scopeId],
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
  input: {
    agentPackageName: string;
    skillId: string;
    createdBy: string;
    /** The exact scope this assignment applies to. Omitted by the pre-scope
     *  callers, which wrote package-global rows — exactly the workspace tier. */
    scope?: { scopeKind: string; scopeId: string };
    source?: AssignmentSource;
    originRunId?: string | null;
  },
  deps?: AssignedSkillsStoreDeps,
): Promise<InsertAssignedSkillResult> {
  const { transaction, table } = resolveDeps(deps);
  const scope = assertAssignmentScope(input.scope ?? WORKSPACE_ASSIGNMENT_SCOPE);
  const source: AssignmentSource = input.source ?? "manual";
  return transaction(async (tx) => {
    // (1) Serialize the whole section per agent package. Namespaced so the key
    // space cannot collide with another subsystem's advisory locks.
    await tx(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      assignmentScopeLockKey(ADVISORY_LOCK_NAMESPACE, input.agentPackageName, scope),
    ]);

    // (2) Idempotent re-check under the lock: a duplicate assign is a no-op
    // that must NOT consume (or be refused by) a cap slot.
    const existing = await tx<RawRow>(
      `SELECT ${COLUMNS}
         FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2
          AND scope_kind = $3 AND scope_id = $4`,
      [input.agentPackageName, input.skillId, scope.scopeKind, scope.scopeId],
    );
    if (existing[0]) return { outcome: "already_assigned", row: toRow(existing[0]) } as const;

    // (3) Cap check under the lock.
    const counted = await tx<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM ${table}
        WHERE agent_package_name = $1 AND scope_kind = $2 AND scope_id = $3`,
      [input.agentPackageName, scope.scopeKind, scope.scopeId],
    );
    const count = Number(counted[0]?.n ?? 0);
    if (count >= AGENT_ASSIGNED_SKILLS_CAP) return { outcome: "cap_exceeded", count } as const;

    // (4) Next position + insert in ONE statement, so the value cannot drift
    // between reading and writing it. `COALESCE(MAX+1, 1)` keeps insertion
    // order stable across removals (positions may go sparse; ordering is what
    // matters, not density). The PK arbiter collapses a racer to DO NOTHING.
    const inserted = await tx<RawRow>(
      `INSERT INTO ${table} (agent_package_name, skill_id, scope_kind, scope_id, source, origin_run_id, "position", created_by)
       SELECT $1, $2, $3, $4, $5, $6, COALESCE(MAX("position"), 0) + 1, $7 FROM ${table}
        WHERE agent_package_name = $1 AND scope_kind = $3 AND scope_id = $4
       ON CONFLICT (agent_package_name, skill_id, scope_kind, scope_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.agentPackageName,
        input.skillId,
        scope.scopeKind,
        scope.scopeId,
        source,
        input.originRunId ?? null,
        input.createdBy,
      ],
    );
    if (inserted[0]) return { outcome: "assigned", row: toRow(inserted[0]) } as const;

    // A racer won the PK arbiter while we held the lock (only reachable when a
    // caller bypasses the transaction seam); report the winner, never a lie.
    const winner = await tx<RawRow>(
      `SELECT ${COLUMNS}
         FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2
          AND scope_kind = $3 AND scope_id = $4`,
      [input.agentPackageName, input.skillId, scope.scopeKind, scope.scopeId],
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
  input: {
    agentPackageName: string;
    skillId: string;
    /** The exact scope the row belongs to; the remove identity carries the FULL
     *  tuple, so removing a project's assignment cannot take the
     *  organization's with it. Omitted ⇒ the workspace tier. */
    scope?: { scopeKind: string; scopeId: string };
  },
  deps?: AssignedSkillsStoreDeps,
): Promise<{ deleted: boolean }> {
  const { query, table } = resolveDeps(deps);
  const scope = assertAssignmentScope(input.scope ?? WORKSPACE_ASSIGNMENT_SCOPE);
  const rows = await query<{ skill_id: string }>(
    `DELETE FROM ${table}
      WHERE agent_package_name = $1 AND skill_id = $2
        AND scope_kind = $3 AND scope_id = $4
      RETURNING skill_id`,
    [input.agentPackageName, input.skillId, scope.scopeKind, scope.scopeId],
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
