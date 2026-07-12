// Skill lifecycle (cinatra#1361, epic #1358) — the DB WRITE PRIMITIVES for the
// revision history + transition audit. Policy (legal transitions,
// authorization, supersede acyclicity, revision-record construction) lives in
// the pure @cinatra-ai/skills `lifecycle` leaf and runs BEFORE these primitives
// are called; these functions only persist, fail-closed. Extracted from
// database.ts (the file-size ratchet); re-exported there for the stable
// `@/lib/database` surface.
//
// These primitives touch only the lifecycle columns (lifecycle_state,
// superseded_by, active_revision_id) + the new tables — NEVER the `skills`
// payload — so they never stale the in-process skill-catalog payload cache.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

/** An immutable revision to record atomically with a skills catalog write. The
 * `source` value is validated by the pure lifecycle policy before it arrives. */
export interface SkillLifecycleRevisionWrite {
  skillId: string;
  revisionId: string;
  contentDigest: string | null;
  source: string;
  basedOnSkillIds: string[] | null;
  baseDigests: Record<string, string> | null;
  authorUserId: string | null;
  /** State to INITIALIZE the skill to when it has none yet ('active' for a new
   * custom skill). An existing state is preserved (COALESCE) — a content
   * re-save of a deprecated skill records a revision but stays deprecated. */
  initialState: string;
}

/**
 * The revision INSERT + active-revision pointer UPDATE for a set of writes.
 * Returned as a query list so the caller can append them to the SAME
 * transaction as a catalog write (replaceSkillCatalogInDatabase) — content and
 * its provenance commit together. INSERT precedes the pointer UPDATE so the
 * composite active-revision FK is satisfied within the transaction.
 */
export function buildSkillLifecycleRevisionQueries(
  schemaName: string,
  writes: SkillLifecycleRevisionWrite[],
): Array<{ text: string; values?: unknown[] }> {
  const s = schemaName.replaceAll('"', '""');
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  for (const w of writes) {
    // PLAIN insert (no ON CONFLICT): a live revision id is a fresh distinct UUID
    // so it never collides — and if one ever did, the collision must ABORT the
    // whole transaction (fail-closed) rather than silently retain a stale
    // immutable row while the pointer moves. The deterministic idempotent seed
    // lives only in the core__0029 backfill, not here.
    queries.push({
      text: `INSERT INTO "${s}"."skill_revisions"
        (id, skill_id, content_digest, source, based_on_skill_ids, base_digests, author_user_id)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      values: [
        w.revisionId,
        w.skillId,
        w.contentDigest,
        w.source,
        w.basedOnSkillIds ? JSON.stringify(w.basedOnSkillIds) : null,
        w.baseDigests ? JSON.stringify(w.baseDigests) : null,
        w.authorUserId,
      ],
    });
    queries.push({
      text: `UPDATE "${s}"."skills"
        SET lifecycle_state = COALESCE(lifecycle_state, $2),
            active_revision_id = $3
        WHERE id = $1`,
      values: [w.skillId, w.initialState, w.revisionId],
    });
  }
  return queries;
}

/** Record an immutable revision + move the active-revision pointer, in its own
 * transaction. NOT atomic with a payload write — prefer the `lifecycleWrites`
 * arm of replaceSkillCatalogInDatabase for content writes; this is for
 * out-of-band recording where no catalog write accompanies it. */
export function recordSkillRevisionInDatabase(write: SkillLifecycleRevisionWrite): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: buildSkillLifecycleRevisionQueries(postgresSchema, [write]),
  });
}

export interface SkillLifecycleTransitionWrite {
  skillId: string;
  /** Compare-and-swap guard — the state the caller validated the transition FROM. */
  expectedFrom: string;
  to: string;
  /** When set, also record the supersede edge (the no-cycle guard runs in policy). */
  supersededBy?: string | null;
  auditId: string;
  actorUserId?: string | null;
  actorType?: string | null;
  reason?: string | null;
}

/**
 * Atomic, race-free compare-and-swap lifecycle transition + audit (cinatra#1361
 * AC3). Two statements in ONE transaction:
 *
 *  1. a transaction-scoped advisory lock that SERIALIZES all supersede-graph
 *     mutations, so the acyclicity check below reads a stable graph;
 *  2. a single statement that (a) swaps lifecycle_state ONLY when it still
 *     equals `expectedFrom` (TOCTOU-safe on state), (b) sets `superseded_by`
 *     ONLY when doing so would NOT create a cycle — a WITH RECURSIVE walk of the
 *     successor chain from the proposed target carries its visited-path and
 *     flags `bad` on a self-edge, a loop back to this skill, OR any revisited
 *     node (a cycle anywhere in the target's reachable chain); expansion stops
 *     at the first `bad` node so it always terminates — and (c) writes the audit
 *     row ONLY when the swap matched (the audit SELECTs from the update CTE).
 *
 * Returns `{ changed }` — false means the state moved underneath OR the
 * supersede edge would create a cycle (a fail-closed no-op, no audit written).
 * The caller's pure policy gate (authorization + a fast app-side no-cycle
 * pre-check) runs first; the DB guard here is the authoritative, race-free
 * backstop (service enforcement alone is insufficient — the semantic_assertion
 * precedent).
 *
 * Audit rows record state→state TRANSITIONS; a skill's INITIAL activation
 * (NULL → active) is provenance carried by its first revision, not an audit row
 * (so `expectedFrom` is always a real prior state).
 */
export function applySkillLifecycleTransitionInDatabase(input: SkillLifecycleTransitionWrite): { changed: boolean } {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext('cinatra-skill-supersede-graph'))` },
      {
        text: `WITH RECURSIVE walk(id, seen, bad) AS (
          SELECT $4::text, ARRAY[$4::text], ($4 = $1)
          UNION ALL
          SELECT sk.superseded_by, w.seen || sk.superseded_by,
                 (sk.superseded_by = $1 OR sk.superseded_by = ANY(w.seen))
            FROM "${s}"."skills" sk JOIN walk w ON sk.id = w.id
           WHERE sk.superseded_by IS NOT NULL AND NOT w.bad
        ),
        upd AS (
          UPDATE "${s}"."skills"
             SET lifecycle_state = $3,
                 superseded_by = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE superseded_by END
           WHERE id = $1 AND lifecycle_state = $2
             AND ($4::text IS NULL OR NOT EXISTS (SELECT 1 FROM walk WHERE bad))
          RETURNING id
        )
        INSERT INTO "${s}"."skill_lifecycle_audit"
          (id, skill_id, from_state, to_state, actor_user_id, actor_type, reason)
        SELECT $5, $1, $2, $3, $6, $7, $8 FROM upd
        RETURNING id`,
        values: [
          input.skillId,
          input.expectedFrom,
          input.to,
          input.supersededBy ?? null,
          input.auditId,
          input.actorUserId ?? null,
          input.actorType ?? null,
          input.reason ?? null,
        ],
      },
    ],
  });
  const audit = results[1];
  return { changed: (audit?.rows?.length ?? 0) > 0 };
}
