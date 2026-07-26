// Bootstrap DDL for the skill-lifecycle history + audit tables (cinatra#1361,
// epic #1358) — the ADDITIVE half of the lifecycle schema: the brand-new tables
// (skill_revisions, skill_lifecycle_audit, and the #1362 content-addressable
// skill_revision_contents), their indexes, and the append-only immutability
// triggers. The DESTRUCTIVE half (the `skills` typed columns + CHECK / self-FK /
// composite active-revision FK) stays INLINE in buildCreateStoreSchemaQueries
// (src/lib/drizzle-store.ts) so the schema-migration gate SEES it and demands
// the core__0029 migration artifact.
//
// cinatra#1362 (content authority + rollback) extends this leaf: skill_revisions
// gains `restores_revision_id` (a rollback's restored-revision provenance, self-
// FK'd + biconditional with source='rollback') and the source CHECK gains
// 'rollback'; skill_revision_contents is the durable content a revision's digest
// resolves to. On an EXISTING deployment these arrive via core__0031; on a fresh
// bootstrap they ship directly here — the two paths converge (idempotent DDL).
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// co-owner-constraint-schema.ts / the postgres-sync-leaf-imports test). The
// enum value sets below are a schema contract mirrored by @cinatra-ai/skills
// `REVISION_SOURCES`; skill-lifecycle-schema.test.ts asserts they stay in sync.

/**
 * skill_revisions (immutable revision history) + skill_lifecycle_audit
 * (transition audit log). Spread into buildCreateStoreSchemaQueries AFTER the
 * `skills` CREATE TABLE + the inline `skills` lifecycle columns (skill_revisions
 * needs no FK to skills, but the inline composite active-revision FK on `skills`
 * needs skill_revisions to exist — that inline FK is spread AFTER this).
 */
export function skillLifecycleSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  const qLit = schemaName.replaceAll("'", "''"); // string literal
  return [
    // ---- skill_revisions: append-only immutable content-revision history ----
    // `id` is a DISTINCT event id (NOT the content digest) — repeated identical
    // content still gets a distinct revision, so provenance is per write.
    // `skill_id` carries NO foreign key ON PURPOSE: revisions are durable /
    // tombstoned history that survives a hard skill delete, and — critically —
    // an FK ON DELETE CASCADE would fire the BELOW append-only BEFORE DELETE
    // trigger during a parent-skill delete and abort the whole catalog-replace
    // transaction (replaceSkillCatalogInDatabase deletes vanished skill rows).
    // `content_digest` is NULLABLE: the migration backfill seeds it from a
    // legacy row's stored source digest when present, NULL when unknown.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_revisions" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      skill_id text NOT NULL,
      content_digest text,
      source text NOT NULL,
      based_on_skill_ids jsonb,
      base_digests jsonb,
      author_user_id text,
      restores_revision_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT skill_revisions_source_check CHECK (source IN ('manual','autosave','hitl','chat-capture','migration','rollback')),
      CONSTRAINT skill_revisions_rollback_provenance_check CHECK ((source = 'rollback') = (restores_revision_id IS NOT NULL)),
      CONSTRAINT skill_revisions_id_skill_uk UNIQUE (id, skill_id),
      CONSTRAINT skill_revisions_restores_fk FOREIGN KEY (restores_revision_id, skill_id) REFERENCES "${q}"."skill_revisions" (id, skill_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_revisions_skill_created_idx ON "${q}"."skill_revisions" (skill_id, created_at DESC)` },

    // ---- Content authority + rollback (cinatra#1362): EVOLVE an EXISTING
    // skill_revisions on a bootstrap-seeded schema. The CREATE above already
    // carries these on a fresh DB, but CREATE ... IF NOT EXISTS is a no-op once
    // the table exists (an A1-bootstrapped deployment), so these idempotent
    // ALTERs are what actually reach it on boot. The matching operator-upgrade
    // path is migrations/core/core__0031. Additive-safe: existing rows carry a
    // NULL restores_revision_id and a source in the original set. (Placed BEFORE
    // skill_lifecycle_audit so the audit table's "no FK" shape test is unambiguous.)
    { text: `ALTER TABLE "${q}"."skill_revisions" ADD COLUMN IF NOT EXISTS restores_revision_id text` },
    // A CHECK's IN-list can't be widened by the guarded add-if-absent pattern
    // (the name already exists), so DROP+ADD in a DO block — atomic (no window
    // where source is unconstrained), convergent to the 6-value set.
    { text: `DO $$
      BEGIN
        ALTER TABLE "${q}"."skill_revisions" DROP CONSTRAINT IF EXISTS skill_revisions_source_check;
        ALTER TABLE "${q}"."skill_revisions"
          ADD CONSTRAINT skill_revisions_source_check
          CHECK (source IN ('manual','autosave','hitl','chat-capture','migration','rollback'));
      END $$;` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${qLit}' AND table_name = 'skill_revisions'
            AND constraint_name = 'skill_revisions_rollback_provenance_check'
        ) THEN
          ALTER TABLE "${q}"."skill_revisions"
            ADD CONSTRAINT skill_revisions_rollback_provenance_check
            CHECK ((source = 'rollback') = (restores_revision_id IS NOT NULL));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${qLit}' AND table_name = 'skill_revisions'
            AND constraint_name = 'skill_revisions_restores_fk'
        ) THEN
          ALTER TABLE "${q}"."skill_revisions"
            ADD CONSTRAINT skill_revisions_restores_fk
            FOREIGN KEY (restores_revision_id, skill_id)
            REFERENCES "${q}"."skill_revisions"(id, skill_id);
        END IF;
      END $$;` },

    // ---- skill_revision_contents: content-addressable immutable blobs (#1362) ----
    // The AUTHORITATIVE content a revision's content_digest resolves to. Keyed by
    // the sha256 digest, so identical content across revisions/skills dedups to
    // ONE row and a rollback "points at a prior content digest" without copying.
    // Two DB-enforced integrity CHECKs make a wrong blob IMPOSSIBLE (so the
    // write path's ON CONFLICT DO NOTHING can never retain incorrect content):
    //   * the digest equals sha256(content) — content-addressing is provable;
    //   * byte_length equals octet_length(content).
    // Immutable: a BEFORE UPDATE OR DELETE trigger raises (a blob for a digest is
    // a pure function of that digest — it can only ever be inserted).
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_revision_contents" (
      content_digest text PRIMARY KEY,
      content text NOT NULL,
      byte_length integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT skill_revision_contents_digest_check CHECK (content_digest = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
      CONSTRAINT skill_revision_contents_length_check CHECK (byte_length = octet_length(content))
    )` },
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_skill_revision_contents_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'skill_revision_contents is append-only: % forbidden — content is immutable per digest', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_skill_revision_contents_append_only ON "${q}"."skill_revision_contents"` },
    { text: `CREATE TRIGGER trg_skill_revision_contents_append_only BEFORE UPDATE OR DELETE ON "${q}"."skill_revision_contents" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_skill_revision_contents_append_only"()` },
    // DB-level immutability: any UPDATE or DELETE of a revision row raises.
    // The active-revision POINTER lives on skills.active_revision_id — the
    // only mutable element — so re-pointing never touches a revision row.
    // Mirrors fn_representation_append_only / fn_run_context_selections_append_only.
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_skill_revisions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'skill_revisions is append-only: % forbidden — record a NEW revision instead', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_skill_revisions_append_only ON "${q}"."skill_revisions"` },
    { text: `CREATE TRIGGER trg_skill_revisions_append_only BEFORE UPDATE OR DELETE ON "${q}"."skill_revisions" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_skill_revisions_append_only"()` },

    // ---- skill_lifecycle_audit: one row per state->state transition ----
    // `skill_id` carries NO FK (durable across skill deletion — the
    // audit_events / extension_lifecycle_audit precedent). Audit rows record
    // TRANSITIONS between states, so `from_state` is the (real) prior state; a
    // skill's INITIAL activation (NULL -> active) is provenance carried by its
    // first `skill_revisions` row, NOT an audit row. `from_state` stays nullable
    // for forward-compatibility only.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_lifecycle_audit" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      skill_id text NOT NULL,
      from_state text,
      to_state text NOT NULL,
      actor_user_id text,
      actor_type text,
      reason text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_lifecycle_audit_skill_created_idx ON "${q}"."skill_lifecycle_audit" (skill_id, created_at DESC)` },
  ];
}

/**
 * Skill efficacy-loop exposure telemetry (cinatra#1368, epic #1358 S10),
 * mirrored by core__0041. Kept in this pure-strings leaf (not inline in
 * buildCreateStoreSchemaQueries) for file-size-ratchet headroom — all statements
 * are ADDITIVE (nullable columns + a non-unique index), so the schema-migration
 * gate has nothing destructive to see and the operator-upgrade path is covered
 * by the shipped core__0041 artifact.
 *
 * MUST be spread AFTER the `agent_run_skills_used` CREATE TABLE (it ALTERs that
 * table) — the drizzle-store composition places it near the end, where both
 * `agent_run_skills_used` and `skills` already exist.
 *
 * Columns:
 *  - agent_run_skills_used.delivery_mode / invocation_attributable — how a skill
 *    reached the model on the resolving step + whether that mode can attribute a
 *    per-skill invocation. NULLABLE (NULL = the sessionless run-start snapshot,
 *    mode not yet known). A skill exposed only via NULL/non-attributable rows can
 *    never become a deprecation candidate.
 *  - a non-unique agent_run_skills_used.skill_id index for the per-skill rollup.
 *  - skills.deprecation_candidate_dismissed_at — the human "reviewed — keep it"
 *    decision clearing a candidate without deprecating it.
 */
export function skillEfficacySchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    { text: `ALTER TABLE "${q}"."agent_run_skills_used" ADD COLUMN IF NOT EXISTS delivery_mode text` },
    { text: `ALTER TABLE "${q}"."agent_run_skills_used" ADD COLUMN IF NOT EXISTS invocation_attributable boolean` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_skills_used_skill_id_idx ON "${q}"."agent_run_skills_used" (skill_id)` },
    { text: `ALTER TABLE "${q}"."skills" ADD COLUMN IF NOT EXISTS deprecation_candidate_dismissed_at timestamptz` },
  ];
}

// ---------------------------------------------------------------------------
// BUNDLE-AWARE content authority (cinatra#2088, epic #2086 S1) — bootstrap DDL
// for the additive half that turns the single-blob content
// authority (core__0031's `skill_revision_contents`, one immutable UTF-8 text
// blob per revision) into a multi-file, binary-capable bundle authority:
//
//   - `skill_bundle_blobs`: a RAW-BYTE content-addressable blob store keyed by
//     the sha256 hex of the bytes. Uniform for text AND binary resources (a
//     UTF-8 file is just its bytes), so a non-UTF-8 reference (an image, a
//     compiled fixture) survives byte-exact where `skill_revision_contents`
//     (a `text` column) could not. Two DB CHECKs make a wrong blob IMPOSSIBLE —
//     content_digest = sha256(content) and byte_length = octet_length(content).
//     A BEFORE UPDATE OR DELETE trigger raises: a blob is a pure function of its
//     digest and can only ever be inserted.
//   - `skill_revision_files`: the immutable revision-file MANIFEST — one row per
//     `(revision_id, path)` binding a bundled file's normalized path to its
//     content_digest (into `skill_bundle_blobs`), byte_length, unix mode, and an
//     `is_router` flag distinguishing the single `SKILL.md`. Append-only trigger.
//     A CHECK enforces exactly-one-router shape at the row level (is_router ⇒
//     path='SKILL.md') and a forward-slash-normalized, traversal-free path.
//   - `skill_bundle_heads`: the bundle authority's CURRENT-BUNDLE POINTER, one
//     row per skill — `(skill_id) → (revision_id, bundle_digest)`. A pointer, so
//     it is deliberately MUTABLE (no append-only trigger) exactly like
//     `skills.active_revision_id`; the history it points into stays immutable.
//     It exists because the lifecycle revision layer (core__0029) covers ONLY
//     custom/personal skills — a DERIVED (extension/package) skill has a NULL
//     `skills.active_revision_id` forever — so without a bundle-authority-owned
//     pointer the byte-bound sync path could not resolve a bundle for the
//     extension skills that are the bulk of the mirror. A custom skill's head is
//     written in the SAME transaction as its lifecycle revision; a derived
//     skill's head is written by the capture phase under a deterministic
//     content-addressed revision id (`bundle:<bundleDigest>`).
//   - `skill_revisions.bundle_digest`: the REVISION IDENTITY — the deterministic
//     digest over the sorted `(path, content_digest)` set (computed by the pure
//     `computeBundleDigest`). Nullable: a legacy (pre-S1) revision carries NULL
//     until its bundle is ingested.
//   - `anthropic_skill_sync.revision_id` + `.bundle_digest`: the byte-bound sync
//     binding — a remote mirror row records WHICH stored revision (and its
//     bundle identity) the uploaded bytes were derived from, so drift is a pure
//     manifest comparison and never a disk re-hash. Nullable for pre-S1 rows.
//
// Lives in THIS leaf (rather than its own module) so it inherits the same
// zero-import synchronous-leaf contract drizzle-store.ts's require() composition
// depends on, and so composing it costs the hub no new lines. The operator-upgrade twin is migrations/core/
// core__0084; the two paths converge (idempotent, fully-guarded DDL). Spread
// into buildCreateStoreSchemaQueries AFTER skillLifecycleSchemaQueries (needs
// `skill_revisions` to exist for the ADD COLUMN) and AFTER the anthropic skill
// tables (needs `anthropic_skill_sync` to exist for its ADD COLUMNs).

/**
 * Bundle authority tables + the additive columns on `skill_revisions` and
 * `anthropic_skill_sync`. `schemaName` is the app schema (SUPABASE_SCHEMA).
 */
export function skillBundleSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // ---- skill_bundle_blobs: raw-byte content-addressable authority ----
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_bundle_blobs" (
      content_digest text PRIMARY KEY,
      content bytea NOT NULL,
      byte_length integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT skill_bundle_blobs_digest_check CHECK (content_digest = encode(sha256(content), 'hex')),
      CONSTRAINT skill_bundle_blobs_length_check CHECK (byte_length = octet_length(content))
    )` },
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_skill_bundle_blobs_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'skill_bundle_blobs is append-only: % forbidden — content is immutable per digest', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_skill_bundle_blobs_append_only ON "${q}"."skill_bundle_blobs"` },
    { text: `CREATE TRIGGER trg_skill_bundle_blobs_append_only BEFORE UPDATE OR DELETE ON "${q}"."skill_bundle_blobs" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_skill_bundle_blobs_append_only"()` },

    // ---- skill_revision_files: the immutable revision-file manifest ----
    // `revision_id` + `skill_id` carry NO FK (mirrors skill_revisions: durable
    // history that survives a hard skill delete; an ON DELETE CASCADE would fire
    // the append-only trigger during a catalog-replace and abort the whole
    // transaction). `mode` is the unix file mode (0o644 = 420 default). The
    // path CHECK rejects an absolute path, a `\` (must be POSIX-normalized before
    // insert), a `..` traversal segment, and the empty string; `is_router`
    // implies path='SKILL.md' so a manifest can never mark a non-router file the
    // router.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_revision_files" (
      revision_id text NOT NULL,
      skill_id text NOT NULL,
      path text NOT NULL,
      content_digest text NOT NULL,
      byte_length integer NOT NULL,
      mode integer NOT NULL DEFAULT 420,
      is_router boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT skill_revision_files_pk PRIMARY KEY (revision_id, path),
      CONSTRAINT skill_revision_files_path_check CHECK (
        length(path) > 0
        AND left(path, 1) <> '/'
        AND position('\\' in path) = 0
        AND path NOT LIKE '%/..'
        AND path NOT LIKE '../%'
        AND path NOT LIKE '%/../%'
        AND path <> '..'
      ),
      CONSTRAINT skill_revision_files_router_check CHECK (is_router = false OR path = 'SKILL.md')
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_revision_files_skill_idx ON "${q}"."skill_revision_files" (skill_id)` },
    { text: `CREATE INDEX IF NOT EXISTS skill_revision_files_digest_idx ON "${q}"."skill_revision_files" (content_digest)` },
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_skill_revision_files_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'skill_revision_files is append-only: % forbidden — record a NEW revision instead', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_skill_revision_files_append_only ON "${q}"."skill_revision_files"` },
    { text: `CREATE TRIGGER trg_skill_revision_files_append_only BEFORE UPDATE OR DELETE ON "${q}"."skill_revision_files" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_skill_revision_files_append_only"()` },

    // ---- skill_bundle_heads: the current-bundle pointer (one row per skill) ----
    // MUTABLE by design (a pointer, not history) — no append-only trigger. No FK
    // to `skills` (same reasoning as skill_revisions: a catalog-replace deletes
    // vanished skill rows and an ON DELETE CASCADE would be a surprising
    // cross-table effect); a head whose skill vanished is simply never read
    // (every read is skill-scoped from the catalog).
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_bundle_heads" (
      skill_id text PRIMARY KEY,
      revision_id text NOT NULL,
      bundle_digest text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_bundle_heads_revision_idx ON "${q}"."skill_bundle_heads" (revision_id)` },

    // ---- skill_revisions.bundle_digest: the revision identity ----
    // Nullable: a pre-S1 revision has none until ingestion computes it.
    { text: `ALTER TABLE "${q}"."skill_revisions" ADD COLUMN IF NOT EXISTS bundle_digest text` },

    // ---- anthropic_skill_sync: byte-bound sync binding ----
    // Which stored revision (+ its bundle identity) the uploaded bytes derive
    // from. Nullable so an already-provisioned namespace upgrades additively;
    // populated on the next byte-bound sync.
    { text: `ALTER TABLE "${q}"."anthropic_skill_sync" ADD COLUMN IF NOT EXISTS revision_id text` },
    { text: `ALTER TABLE "${q}"."anthropic_skill_sync" ADD COLUMN IF NOT EXISTS bundle_digest text` },
  ];
}
