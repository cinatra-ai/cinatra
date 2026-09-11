import "server-only";

// ---------------------------------------------------------------------------
// `agent_assigned_context` DB primitives (cinatra#2813 S1, epic #2812).
//
// The artifact twin of `agent_assigned_skills`: which context artifacts an
// agent carries, per slot, PER SCOPE. It shares the exact-scope tuple rule and
// the per-(package, scope) advisory lock with the skills store, and differs in
// two deliberate ways.
//
// IT IS UNCAPPED. The skills store caps at five per exact scope because the
// injection ceiling is a scarce, shared budget. A context slot is not that: the
// slot itself declares its own min/max in the agent's manifest and the planner
// applies it at run time, so a cap in the store would be a second, silently
// different answer to a question the manifest already answers.
//
// IT VALIDATES BEFORE IT WRITES, FAIL-CLOSED. Three things must be true before
// a row lands, and every one of them is refused rather than assumed when it
// cannot be established:
//
//   1. the slot must EXIST in the agent's trusted slot manifest — a row naming
//      a slot the agent does not declare is unreachable configuration that
//      would silently start applying if the agent ever declared that name;
//   2. the artifact must be VISIBLE TO THE WRITER — otherwise attaching an
//      artifact would be a read primitive: a person could bind an id they
//      cannot see and read its content back through the agent;
//   3. the artifact must be COMPATIBLE with the slot's accepted extensions —
//      the slot states what it can carry, and a mismatch is a run-time failure
//      moved to write time, where a person can still fix it.
//
// A validation source that THROWS refuses the write. An unreadable answer is
// not a yes; admitting on error would turn a transient outage into an open gate.
//
// ORDERING is `position` then `artifact_id`, both per scope tuple. The second
// key is not decoration: positions may go sparse after removals and two rows
// can be written in the same statement batch, so ties need a total order or the
// planner would receive a different sequence on different reads.
// ---------------------------------------------------------------------------

import { getPooledDb } from "@/lib/db/pooled";
import {
  assertAssignmentScope,
  assignmentScopeLockKey,
  type AssignmentScope,
} from "@/lib/assignment-scope";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** The table, named once so both DDL homes and the store agree. */
export const AGENT_ASSIGNED_CONTEXT_TABLE = "agent_assigned_context";

/** The advisory-lock namespace, so the per-(package, scope) key cannot collide
 *  with the skills store's key space or any other subsystem's. */
const ADVISORY_LOCK_NAMESPACE = "agent_assigned_context";

export type AgentAssignedContextRow = {
  agentPackageName: string;
  slotId: string;
  artifactId: string;
  scopeKind: AssignmentScope["scopeKind"];
  scopeId: string;
  position: number;
  createdBy: string;
  createdAt: string;
};

export type AssignedContextQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

/** Runs `fn` inside ONE transaction. `pg_advisory_xact_lock` is held only for
 *  the length of the transaction that took it, so issuing it on a pooled
 *  autocommit connection releases it before the next statement runs — the
 *  locked section must share one transaction with the lock, exactly as the
 *  skills store does. Tests inject a pass-through over the query double. */
export type AssignedContextTransaction = <T>(
  fn: (txQuery: AssignedContextQuery) => Promise<T>,
) => Promise<T>;

/** The three server-side validators, injected so the store stays a store. */
export type AgentAssignedContextValidators = {
  /** Is `slotId` declared by this agent package's TRUSTED slot manifest? */
  slotExists: (input: { agentPackageName: string; slotId: string }) => Promise<boolean>;
  /** Can the WRITER (not the agent) see this artifact at this scope? */
  artifactVisibleToWriter: (input: {
    artifactId: string;
    writerId: string;
    scope: AssignmentScope;
  }) => Promise<boolean>;
  /** Does the slot's accepted-extension list admit this artifact? */
  slotAcceptsArtifact: (input: {
    agentPackageName: string;
    slotId: string;
    artifactId: string;
  }) => Promise<boolean>;
};

export type AgentAssignedContextStoreDeps = Partial<AgentAssignedContextValidators> & {
  query?: AssignedContextQuery;
  transaction?: AssignedContextTransaction;
  schema?: string;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "agent-assigned-context" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function defaultTransaction<T>(
  fn: (txQuery: AssignedContextQuery) => Promise<T>,
): Promise<T> {
  const pool = await getPooledDb({ name: "agent-assigned-context" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txQuery: AssignedContextQuery = async <U = unknown>(
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

function passthroughTransaction(query: AssignedContextQuery): AssignedContextTransaction {
  return async (fn) => fn(query);
}

function resolveDeps(deps?: AgentAssignedContextStoreDeps): {
  query: AssignedContextQuery;
  transaction: AssignedContextTransaction;
  table: string;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quoted
  // defensively all the same.
  const table = `"${schema.replaceAll('"', '""')}"."${AGENT_ASSIGNED_CONTEXT_TABLE}"`;
  const query = deps?.query ?? defaultQuery;
  const transaction =
    deps?.transaction ?? (deps?.query ? passthroughTransaction(deps.query) : defaultTransaction);
  return { query, transaction, table };
}

type RawRow = {
  agent_package_name: string;
  slot_id: string;
  artifact_id: string;
  scope_kind: string;
  scope_id: string;
  position: number | string;
  created_by: string;
  created_at: string | Date;
};

function toRow(raw: RawRow): AgentAssignedContextRow {
  return {
    agentPackageName: raw.agent_package_name,
    slotId: raw.slot_id,
    artifactId: raw.artifact_id,
    scopeKind: raw.scope_kind as AssignmentScope["scopeKind"],
    scopeId: raw.scope_id,
    position: Number(raw.position),
    createdBy: raw.created_by,
    createdAt:
      raw.created_at instanceof Date ? raw.created_at.toISOString() : String(raw.created_at),
  };
}

const COLUMNS = `agent_package_name, slot_id, artifact_id, scope_kind, scope_id, "position", created_by, created_at`;

/**
 * The ordered rows for ONE agent package at ONE exact scope.
 *
 * ACTOR-INDEPENDENT, like the skills store: no owner predicate. The scope tuple
 * says which scope a row applies to; whether the READER may see that scope is a
 * separate question, answered by `resolveAssignmentReadAuthority` at the
 * surface, never by narrowing this query.
 */
export async function readAssignedContextForAgentScope(
  agentPackageName: string,
  scope: { scopeKind: string; scopeId: string },
  deps?: AgentAssignedContextStoreDeps,
): Promise<AgentAssignedContextRow[]> {
  const { query, table } = resolveDeps(deps);
  if (!agentPackageName) return [];
  const valid = assertAssignmentScope(scope);
  const rows = await query<RawRow>(
    `SELECT ${COLUMNS}
       FROM ${table}
      WHERE agent_package_name = $1 AND scope_kind = $2 AND scope_id = $3
      ORDER BY "position" ASC, artifact_id ASC`,
    [agentPackageName, valid.scopeKind, valid.scopeId],
  );
  return rows.map(toRow);
}

export type AssignedContextRefusal =
  | "unknown-slot"
  | "artifact-not-visible"
  | "incompatible-artifact"
  | "validation-unreadable";

export type InsertAssignedContextResult =
  | { outcome: "assigned"; row: AgentAssignedContextRow }
  | { outcome: "already_assigned"; row: AgentAssignedContextRow }
  | { outcome: "refused"; reason: AssignedContextRefusal };

function refuseUnreadable(what: string, err: unknown): void {
  // The identifiers are passed as ARGUMENTS, never spliced into the message: a
  // caller-influenced value must not be able to shape the log format.
  console.warn(
    "[agent-assigned-context] validation source unreadable — refusing the write. source / cause:",
    String(what)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 120),
    err instanceof Error ? err.message : err,
  );
}

/**
 * Attach ONE artifact to ONE slot of ONE agent at ONE exact scope.
 *
 * Validation first (and entirely outside the transaction — none of it touches
 * this table, so holding the lock across it would serialize unrelated writers
 * behind a manifest read), then the locked section, which runs inside ONE
 * transaction because an xact-scoped advisory lock is worthless without one:
 *
 *   advisory lock → idempotent re-check → next position → insert
 *
 * There is no cap count: the store is uncapped by design.
 */
export async function insertAssignedContext(
  input: {
    agentPackageName: string;
    slotId: string;
    artifactId: string;
    scope: { scopeKind: string; scopeId: string };
    createdBy: string;
  },
  deps?: AgentAssignedContextStoreDeps,
): Promise<InsertAssignedContextResult> {
  const { transaction, table } = resolveDeps(deps);
  // Throws on a malformed tuple: an invalid scope is a caller defect, not a
  // refusal the surface should render as a choice.
  const scope = assertAssignmentScope(input.scope);

  const slotExists = deps?.slotExists;
  const artifactVisibleToWriter = deps?.artifactVisibleToWriter;
  const slotAcceptsArtifact = deps?.slotAcceptsArtifact;
  if (!slotExists || !artifactVisibleToWriter || !slotAcceptsArtifact) {
    // Fail-closed: a caller that supplies no validators gets no write. The
    // wiring of the real sources is the surface's job (S2), and a store that
    // defaulted them to "yes" would be an open gate waiting for one forgetful
    // call site.
    refuseUnreadable("validators", new Error("no validators supplied"));
    return { outcome: "refused", reason: "validation-unreadable" };
  }

  try {
    if (!(await slotExists({ agentPackageName: input.agentPackageName, slotId: input.slotId }))) {
      return { outcome: "refused", reason: "unknown-slot" };
    }
    if (
      !(await artifactVisibleToWriter({
        artifactId: input.artifactId,
        writerId: input.createdBy,
        scope,
      }))
    ) {
      return { outcome: "refused", reason: "artifact-not-visible" };
    }
    if (
      !(await slotAcceptsArtifact({
        agentPackageName: input.agentPackageName,
        slotId: input.slotId,
        artifactId: input.artifactId,
      }))
    ) {
      return { outcome: "refused", reason: "incompatible-artifact" };
    }
  } catch (err) {
    refuseUnreadable("slot/artifact validation", err);
    return { outcome: "refused", reason: "validation-unreadable" };
  }

  // ONE transaction from the lock to the insert. `pg_advisory_xact_lock` is
  // held only for the length of the TRANSACTION that took it, so a lock
  // issued on an autocommit pooled connection is released before the very
  // next statement and serializes nothing: two concurrent writers would then
  // read the same `MAX(position)` and land on the same slot. The validators
  // above stay OUTSIDE it — none of them touch this table.
  return transaction<InsertAssignedContextResult>(async (tx) => {
    // (1) Serialize per (package, EXACT scope) so two concurrent attachments
    // cannot compute the same next position.
    await tx(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      assignmentScopeLockKey(ADVISORY_LOCK_NAMESPACE, input.agentPackageName, scope),
    ]);

    // (2) Idempotent re-check under the lock: a re-submitted tuple is a no-op.
    const existing = await tx<RawRow>(
      `SELECT ${COLUMNS} FROM ${table}
        WHERE agent_package_name = $1 AND slot_id = $2 AND artifact_id = $3
          AND scope_kind = $4 AND scope_id = $5`,
      [input.agentPackageName, input.slotId, input.artifactId, scope.scopeKind, scope.scopeId],
    );
    if (existing[0]) return { outcome: "already_assigned", row: toRow(existing[0]) };

    // (3) Next position WITHIN the scope tuple + insert in ONE statement, so the
    // value cannot drift between reading and writing it.
    const inserted = await tx<RawRow>(
      `INSERT INTO ${table} (agent_package_name, slot_id, artifact_id, scope_kind, scope_id, "position", created_by)
       SELECT $1, $2, $3, $4, $5, COALESCE(MAX("position"), 0) + 1, $6 FROM ${table}
        WHERE agent_package_name = $1 AND scope_kind = $4 AND scope_id = $5
       ON CONFLICT (agent_package_name, slot_id, artifact_id, scope_kind, scope_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.agentPackageName,
        input.slotId,
        input.artifactId,
        scope.scopeKind,
        scope.scopeId,
        input.createdBy,
      ],
    );
    if (inserted[0]) return { outcome: "assigned", row: toRow(inserted[0]) };

    // A racer won the key arbiter while we held the lock (only reachable when a
    // caller bypasses the lock); report the winner, never a lie.
    const winner = await tx<RawRow>(
      `SELECT ${COLUMNS} FROM ${table}
        WHERE agent_package_name = $1 AND slot_id = $2 AND artifact_id = $3
          AND scope_kind = $4 AND scope_id = $5`,
      [input.agentPackageName, input.slotId, input.artifactId, scope.scopeKind, scope.scopeId],
    );
    if (winner[0]) return { outcome: "already_assigned", row: toRow(winner[0]) };
    throw new Error(
      "insertAssignedContext: insert produced no row and no existing row under the advisory lock",
    );
  });
}


/** Detach ONE artifact by its FULL tuple identity. Idempotent. */
export async function deleteAssignedContext(
  input: {
    agentPackageName: string;
    slotId: string;
    artifactId: string;
    scope: { scopeKind: string; scopeId: string };
  },
  deps?: AgentAssignedContextStoreDeps,
): Promise<{ deleted: boolean }> {
  const { query, table } = resolveDeps(deps);
  const scope = assertAssignmentScope(input.scope);
  const rows = await query<{ artifact_id: string }>(
    `DELETE FROM ${table}
      WHERE agent_package_name = $1 AND slot_id = $2 AND artifact_id = $3
        AND scope_kind = $4 AND scope_id = $5
      RETURNING artifact_id`,
    [input.agentPackageName, input.slotId, input.artifactId, scope.scopeKind, scope.scopeId],
  );
  return { deleted: rows.length > 0 };
}

/** One removed attachment, reported back so a teardown can log what it swept. */
export type RemovedAssignedContext = {
  agentPackageName: string;
  slotId: string;
  artifactId: string;
  scopeKind: string;
  scopeId: string;
};

/**
 * PACKAGE-side teardown: every attachment this agent package carries, at EVERY
 * scope. Same reasoning as the skills store — a retained row is an
 * orphan-reapply hazard, not an audit record, because reinstalling the package
 * re-derives the same slot ids and delivery would silently resume from a
 * configuration nobody re-made.
 */
export async function deleteAssignedContextForAgentPackage(
  agentPackageName: string,
  deps?: AgentAssignedContextStoreDeps,
): Promise<{ removed: RemovedAssignedContext[] }> {
  const { query, table } = resolveDeps(deps);
  if (!agentPackageName) return { removed: [] };
  const rows = await query<Omit<RawRow, "agent_package_name" | "position" | "created_by" | "created_at">>(
    `DELETE FROM ${table} WHERE agent_package_name = $1
     RETURNING slot_id, artifact_id, scope_kind, scope_id`,
    [agentPackageName],
  );
  return {
    removed: rows.map((r) => ({
      agentPackageName,
      slotId: r.slot_id,
      artifactId: r.artifact_id,
      scopeKind: r.scope_kind,
      scopeId: r.scope_id,
    })),
  };
}

/**
 * ARTIFACT-side sweep.
 *
 * The FK already carries `ON DELETE CASCADE`, so a deleted artifact takes its
 * attachments with it without anyone asking. This exists for the callers that
 * retire an artifact WITHOUT deleting its row (tombstoning, a retention sweep)
 * and must still not leave an agent pointing at it.
 */
export async function deleteAssignedContextForArtifacts(
  artifactIds: readonly string[],
  deps?: AgentAssignedContextStoreDeps,
): Promise<{ removed: RemovedAssignedContext[] }> {
  const { query, table } = resolveDeps(deps);
  const ids = [...new Set(artifactIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { removed: [] };
  const rows = await query<RawRow>(
    `DELETE FROM ${table} WHERE artifact_id = ANY($1::text[])
     RETURNING agent_package_name, slot_id, artifact_id, scope_kind, scope_id`,
    [ids],
  );
  return {
    removed: rows.map((r) => ({
      agentPackageName: r.agent_package_name,
      slotId: r.slot_id,
      artifactId: r.artifact_id,
      scopeKind: r.scope_kind,
      scopeId: r.scope_id,
    })),
  };
}
