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
import { buildRevisionBundleQueries, bundleDigestForFiles, type BundleFileInput } from "@/lib/skill-bundle-store";

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
  /** The prior revision this write RESTORES — non-null iff `source==='rollback'`
   * (cinatra#1362). Persisted to `skill_revisions.restores_revision_id`. */
  restoresRevisionId?: string | null;
  /** The content blob to store (cinatra#1362 content authority). When present
   * (with a non-null `contentDigest`) the write ALSO upserts
   * `skill_revision_contents (contentDigest -> content)` so the active revision
   * resolves to durable authoritative content. The DB CHECK enforces
   * `contentDigest == sha256(content)`, so a mismatched pair aborts the write. */
  content?: string | null;
  /** The bundle-aware content authority (cinatra#2088, epic #2086 S1): the
   * revision's FILE SET. When present (non-empty) this records the immutable
   * revision-file manifest (`skill_revision_files`) + content-addressed blobs
   * (`skill_bundle_blobs`) atomically with the revision, and stamps the
   * revision identity (`skill_revisions.bundle_digest`) at INSERT. An authored/
   * chat-captured skill passes a bundle-of-one (`[{path:'SKILL.md', bytes,
   * isRouter:true}]`) — closing the "custom skills can never carry references"
   * gap: the skill is now a bundle it can grow. Structurally a
   * `BundleFileInput[]`; typed inline so this write stays free of a value
   * import at its many call sites. */
  bundleFiles?: Array<{ path: string; bytes: Buffer; mode?: number; isRouter?: boolean }> | null;
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
    // Content authority (cinatra#1362): store the content blob FIRST, keyed by
    // its digest, so the revision's content_digest resolves to durable
    // authoritative content. ON CONFLICT DO NOTHING dedups identical content
    // (a digest is a pure function of content) — safe because the table's
    // blob-integrity CHECK guarantees any stored row already hashes to its
    // digest, so a "wrong blob under a digest" can never exist. Only emitted
    // when we have BOTH the content and its digest (legacy/seed rows have none).
    if (typeof w.content === "string" && w.contentDigest != null) {
      queries.push({
        text: `INSERT INTO "${s}"."skill_revision_contents" (content_digest, content, byte_length)
          VALUES ($1, $2, octet_length($2))
          ON CONFLICT (content_digest) DO NOTHING`,
        values: [w.contentDigest, w.content],
      });
    }
    // Bundle-aware content authority (cinatra#2088): the revision identity is
    // the digest over the sorted (path, per-file-digest) set. Stamped at INSERT
    // (skill_revisions is append-only — the pointer is the only mutable element,
    // so a digest a revision was born with can never be UPDATED afterward). NULL
    // for a lifecycle write that carries no file set (a pure state re-record).
    const bundleFiles = (w.bundleFiles && w.bundleFiles.length > 0
      ? (w.bundleFiles as BundleFileInput[])
      : null);
    const bundleDigest = bundleFiles ? bundleDigestForFiles(bundleFiles) : null;

    // PLAIN insert (no ON CONFLICT): a live revision id is a fresh distinct UUID
    // so it never collides — and if one ever did, the collision must ABORT the
    // whole transaction (fail-closed) rather than silently retain a stale
    // immutable row while the pointer moves. The deterministic idempotent seed
    // lives only in the core__0029 backfill, not here.
    queries.push({
      text: `INSERT INTO "${s}"."skill_revisions"
        (id, skill_id, content_digest, source, based_on_skill_ids, base_digests, author_user_id, restores_revision_id, bundle_digest)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      values: [
        w.revisionId,
        w.skillId,
        w.contentDigest,
        w.source,
        w.basedOnSkillIds ? JSON.stringify(w.basedOnSkillIds) : null,
        w.baseDigests ? JSON.stringify(w.baseDigests) : null,
        w.authorUserId,
        w.restoresRevisionId ?? null,
        bundleDigest,
      ],
    });
    queries.push({
      text: `UPDATE "${s}"."skills"
        SET lifecycle_state = COALESCE(lifecycle_state, $2),
            active_revision_id = $3
        WHERE id = $1`,
      values: [w.skillId, w.initialState, w.revisionId],
    });
    // APPEND the bundle blob + manifest inserts LAST so a caller that
    // destructures the leading [revisionInsert, pointerUpdate] (or
    // [contentBlob, revisionInsert, pointerUpdate]) is unaffected, and the
    // manifest's revision_id already exists in the same transaction.
    if (bundleFiles) {
      queries.push(...buildRevisionBundleQueries(schemaName, {
        revisionId: w.revisionId,
        skillId: w.skillId,
        files: bundleFiles,
      }));
    }
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

export interface SkillRollbackWrite {
  skillId: string;
  /** Compare-and-swap guard: the active_revision_id the caller observed. The
   * pointer moves ONLY while it still equals this — a concurrent edit/rollback
   * that advanced the head makes the swap a fail-closed no-op (never a silent
   * revert of the concurrent write). */
  expectedActiveRevisionId: string;
  /** Fresh distinct id for the new `rollback` revision. */
  newRevisionId: string;
  /** The prior revision whose content is being restored (provenance). */
  targetRevisionId: string;
  /** The restored content + its digest (the target revision's blob). The digest
   * MUST equal sha256(content) — the DB blob-integrity CHECK enforces it. */
  restoredContent: string;
  restoredContentDigest: string;
  /** Full JSON payload with the restored content + recomputed source digest. */
  restoredPayloadJson: string;
  authorUserId: string | null;
  /** The TARGET revision's bundle identity (cinatra#2088), resolved from its
   * manifest by the caller. When present the current-bundle head advances to
   * the rollback revision carrying this digest, so the authority's current
   * bundle IS the restored file set. Null/absent falls back to the target
   * revision's stamped `bundle_digest`; when that is also NULL (a pre-S1
   * revision that was never captured) the head is left alone and the next
   * capture reconciles it from disk. */
  targetBundleDigest?: string | null;
}

/**
 * Build the atomic rollback query (cinatra#1362) — ONE data-modifying-CTE
 * statement so it is all-or-nothing and the immediate composite active-revision
 * FK is satisfied at statement end (the new revision row and the moved pointer
 * both exist by then):
 *
 *  1. `upd` — compare-and-swap: set the restored payload + re-point
 *     active_revision_id ONLY while the pointer still equals
 *     `expectedActiveRevisionId`. A concurrent write that moved the head makes
 *     `upd` empty.
 *  2. `blob` — ensure the restored content blob exists (ON CONFLICT DO NOTHING;
 *     idempotent — the target's blob already exists). Gated on `upd`.
 *  3. the top-level INSERT records the immutable `rollback` revision. Gated on
 *     `upd`.
 *
 * Because 2 and 3 `SELECT ... FROM upd`, a CAS miss writes NOTHING — no orphan
 * revision, no blob, no pointer move. History is NEVER mutated (only an INSERT +
 * the single mutable pointer move).
 */
export function buildSkillRollbackQuery(
  schemaName: string,
  input: SkillRollbackWrite,
): { text: string; values: unknown[] } {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH upd AS (
        UPDATE "${s}"."skills"
           SET payload = $1, active_revision_id = $2
         WHERE id = $3 AND active_revision_id = $4
        RETURNING id
      ), blob AS (
        INSERT INTO "${s}"."skill_revision_contents" (content_digest, content, byte_length)
        SELECT $5, $6, octet_length($6) FROM upd
        ON CONFLICT (content_digest) DO NOTHING
      ), files AS (
        -- Whole-bundle rollback (cinatra#2088): copy the TARGET revision's file
        -- manifest onto the NEW rollback revision so a rollback restores the
        -- complete prior FILE SET, not just SKILL.md. The content-addressed
        -- blobs already exist (shared by digest), so only the manifest rows are
        -- copied. Gated on the CAS (EXISTS ... FROM upd) so a CAS miss copies
        -- nothing; ON CONFLICT keeps it idempotent.
        INSERT INTO "${s}"."skill_revision_files"
          (revision_id, skill_id, path, content_digest, byte_length, mode, is_router)
        SELECT $2, $3, f.path, f.content_digest, f.byte_length, f.mode, f.is_router
          FROM "${s}"."skill_revision_files" f
         WHERE f.revision_id = $7 AND f.skill_id = $3 AND EXISTS (SELECT 1 FROM upd)
        ON CONFLICT (revision_id, path) DO NOTHING
      ), head AS (
        -- Advance the CURRENT-BUNDLE pointer to the rollback revision, so the
        -- authority's "current bundle" IS the restored file set (otherwise the
        -- head would still name the superseded revision and byte-bound sync
        -- would keep mirroring the rolled-back content). Skipped when the target
        -- carries no bundle identity (a pre-S1 revision) — the next capture
        -- reconciles the head from disk.
        INSERT INTO "${s}"."skill_bundle_heads" (skill_id, revision_id, bundle_digest, updated_at)
        SELECT $3, $2, COALESCE($9::text, tr.bundle_digest), now()
          FROM "${s}"."skill_revisions" tr
         WHERE tr.id = $7 AND tr.skill_id = $3
           AND COALESCE($9::text, tr.bundle_digest) IS NOT NULL
           AND EXISTS (SELECT 1 FROM upd)
        ON CONFLICT (skill_id) DO UPDATE
          SET revision_id = EXCLUDED.revision_id,
              bundle_digest = EXCLUDED.bundle_digest,
              updated_at = now()
      )
      INSERT INTO "${s}"."skill_revisions"
        (id, skill_id, content_digest, source, restores_revision_id, author_user_id, bundle_digest)
      SELECT $2, $3, $5, 'rollback', $7, $8,
             (SELECT tr.bundle_digest FROM "${s}"."skill_revisions" tr WHERE tr.id = $7 AND tr.skill_id = $3)
        FROM upd
      RETURNING id`,
    values: [
      input.restoredPayloadJson,
      input.newRevisionId,
      input.skillId,
      input.expectedActiveRevisionId,
      input.restoredContentDigest,
      input.restoredContent,
      input.targetRevisionId,
      input.authorUserId,
      input.targetBundleDigest ?? null,
    ],
  };
}

/** The authoritative content of a revision: its digest + the durable blob the
 * digest resolves to (cinatra#1362). `content` is null when no blob was ever
 * stored for that digest (a legacy/seed revision) — the caller fails closed. */
export interface SkillRevisionContentRow {
  revisionId: string;
  contentDigest: string | null;
  content: string | null;
}

/**
 * Resolve a TARGET revision's authoritative content for a rollback
 * (cinatra#1362), scoped to its owning skill. Returns `null` when the revision
 * does not exist OR does not belong to `skillId` (fail-closed: a forged/foreign
 * revision id resolves to nothing, never another skill's content). A row with a
 * null `content` means the revision has no durable blob — the caller rejects the
 * rollback loudly rather than restoring unknown content.
 */
export function readSkillRevisionContentForRollback(
  skillId: string,
  revisionId: string,
): SkillRevisionContentRow | null {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        // Composite match (id AND skill_id) enforces same-skill ownership — the
        // read mirror of the composite active-revision / restores FKs.
        text: `SELECT r.id AS revision_id, r.content_digest, c.content
                 FROM "${s}"."skill_revisions" r
                 LEFT JOIN "${s}"."skill_revision_contents" c ON c.content_digest = r.content_digest
                WHERE r.id = $1 AND r.skill_id = $2`,
        values: [revisionId, skillId],
      },
    ],
  });
  const row = results[0]?.rows?.[0] as
    | { revision_id?: string; content_digest?: string | null; content?: string | null }
    | undefined;
  if (!row) return null;
  return {
    revisionId: String(row.revision_id),
    contentDigest: row.content_digest ?? null,
    content: row.content ?? null,
  };
}

/**
 * Resolve a skill's ACTIVE head: the current `active_revision_id` pointer (the
 * compare-and-swap guard a rollback observes) plus the AUTHORITATIVE content the
 * pointer resolves to (cinatra#1362) — active_revision_id → content_digest →
 * `skill_revision_contents.content`. `content` is null when the head has no
 * durable blob yet (a legacy head the backfill could not repair). Returns null
 * when the skill row does not exist. This is the DB-authoritative content
 * accessor; the read-side cutover of the projection readers (payload / disk
 * SKILL.md) onto it is a later lifecycle slice.
 */
export function readSkillActiveRevisionFromDatabase(skillId: string): {
  activeRevisionId: string | null;
  contentDigest: string | null;
  content: string | null;
} | null {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT s.active_revision_id, r.content_digest, c.content
                 FROM "${s}"."skills" s
                 LEFT JOIN "${s}"."skill_revisions" r
                   ON r.id = s.active_revision_id AND r.skill_id = s.id
                 LEFT JOIN "${s}"."skill_revision_contents" c
                   ON c.content_digest = r.content_digest
                WHERE s.id = $1`,
        values: [skillId],
      },
    ],
  });
  const row = results[0]?.rows?.[0] as
    | { active_revision_id?: string | null; content_digest?: string | null; content?: string | null }
    | undefined;
  if (!row) return null;
  return {
    activeRevisionId: row.active_revision_id ?? null,
    contentDigest: row.content_digest ?? null,
    content: row.content ?? null,
  };
}

/** The outcome of a fail-closed lifecycle-state batch read (cinatra#1363). */
export type SkillLifecycleStatesResult =
  | { ok: true; states: Map<string, string | null> }
  | { ok: false };

/**
 * FAIL-CLOSED batch read of `lifecycle_state` for a set of skill ids (A3,
 * cinatra#1363 — consumer-complete state enforcement). Reads the COLUMN
 * directly: `lifecycle_state` is deliberately kept out of the JSON payload (so a
 * transition never stales the payload cache), so the in-process catalog cannot
 * answer this. A fresh column read also means an archived skill is gated
 * immediately, never after a cache TTL.
 *
 * On success returns `{ ok: true, states }` mapping each FOUND id → its
 * `lifecycle_state` (a string, or `null` for a derived/extension row). An id
 * ABSENT from `states` is a row that does not exist — a runtime-delivery caller
 * withholds it (fail-closed). On any DB/read error returns `{ ok: false }` so
 * each caller applies its own posture: delivery consumers fail-closed (withhold
 * all), while the Anthropic mirror sync fails-safe (aborts — it must never
 * over-reclaim a mirror on an ambiguous read).
 *
 * Pairs with `isRuntimeDeliverableLifecycleState` from `@cinatra-ai/skills`:
 * a caller passes `states.has(id) ? states.get(id) : undefined` so a missing id
 * (undefined) fails closed while a resolved NULL (derived) delivers.
 */
export function readSkillLifecycleStates(skillIds: string[]): SkillLifecycleStatesResult {
  const ids = Array.from(
    new Set(skillIds.filter((id): id is string => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) return { ok: true, states: new Map() };
  try {
    ensurePostgresSchema();
    const s = postgresSchema.replaceAll('"', '""');
    const states = new Map<string, string | null>();
    // Chunk so the parameter count stays well under the pg bind limit even for
    // a full-catalog read (the Anthropic sync passes every catalog skill id).
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(", ");
      const results = runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `SELECT id, lifecycle_state FROM "${s}"."skills" WHERE id IN (${placeholders})`,
            values: chunk,
          },
        ],
      });
      const rows = (results[0]?.rows ?? []) as Array<{ id?: unknown; lifecycle_state?: unknown }>;
      for (const row of rows) {
        if (typeof row.id !== "string") continue;
        const st = row.lifecycle_state;
        // Strict: a string state is stored verbatim; a SQL NULL becomes `null`
        // (DERIVED). Any other shape (a malformed/absent value) is deliberately
        // NOT recorded, so the id stays absent from the map and a delivery
        // consumer fails closed on it (undefined ≠ null — never mistaken for
        // derived).
        if (typeof st === "string") states.set(row.id, st);
        else if (st === null) states.set(row.id, null);
      }
    }
    return { ok: true, states };
  } catch {
    // Fail-closed at the READER: the caller decides withhold-all vs abort.
    return { ok: false };
  }
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
