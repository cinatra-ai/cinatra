// core__0084 — bundle-aware skill content authority (cinatra#2088, epic #2086
// S1). The operator-upgrade twin of the fresh-install bootstrap DDL
// (skillBundleSchemaQueries in src/lib/skill-bundle-schema.ts, spread into
// buildCreateStoreSchemaQueries in the SAME PR). Turns the single-blob content
// authority (core__0031's `skill_revision_contents`, one immutable UTF-8 text
// blob per revision) into a multi-file, binary-capable bundle authority:
//
//   - `skill_bundle_blobs`: a RAW-BYTE (bytea) content-addressable blob store
//     keyed by sha256(bytes) hex. Uniform for text AND binary resources, so a
//     non-UTF-8 reference survives byte-exact. Two DB CHECKs make a wrong blob
//     impossible; a BEFORE UPDATE OR DELETE trigger enforces append-only.
//   - `skill_revision_files`: the immutable revision-file MANIFEST — one row per
//     (revision_id, path) binding a bundled file's normalized path to its
//     content_digest, byte_length, unix mode, and an is_router flag for the
//     single SKILL.md. A path CHECK rejects absolute / backslash / `..` paths;
//     a router CHECK binds is_router ⇒ path='SKILL.md'. Append-only trigger.
//   - `skill_bundle_heads`: the bundle authority's current-bundle POINTER, one
//     row per skill. Deliberately mutable (a pointer, like
//     skills.active_revision_id); the history it points into stays immutable. It
//     is what lets a DERIVED (extension/package) skill — which never gets a
//     lifecycle revision, so skills.active_revision_id stays NULL forever — carry
//     a bundle identity at all.
//   - `skill_revisions.bundle_digest`: the revision identity (digest over the
//     sorted (path, content_digest) set). Nullable — a legacy revision is NULL
//     until its bundle is ingested at runtime.
//   - `anthropic_skill_sync.revision_id` + `.bundle_digest`: the byte-bound sync
//     binding (which stored revision + bundle identity the uploaded bytes came
//     from). Nullable — populated on the next byte-bound sync.
//
// ADDITIVE — three brand-new tables (two with append-only triggers, one mutable
// pointer table) plus three ADD COLUMN IF NOT EXISTS. No existing column or
// constraint is altered or dropped,
// so the schema-migration gate classifies this NON-destructive; the artifact +
// manifest fragment are still shipped in the same PR per the append-only ledger
// rule. There is NO backfill: bytea content is not derivable from SQL (it lives
// on disk), so pre-S1 revisions are ingested lazily+idempotently at runtime
// (readActiveRevisionBundleForSync's ingest-if-absent path) — the one-time
// remote re-baseline. Unqualified names ride the runner's search_path.
//
// SEQ 0084 — strictly greater than the max shipped seq on origin/main
// (core__0083). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const bundleAuthorityDdlSql = `
  CREATE TABLE IF NOT EXISTS skill_bundle_blobs (
    content_digest text PRIMARY KEY,
    content bytea NOT NULL,
    byte_length integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT skill_bundle_blobs_digest_check CHECK (content_digest = encode(sha256(content), 'hex')),
    CONSTRAINT skill_bundle_blobs_length_check CHECK (byte_length = octet_length(content))
  );

  CREATE OR REPLACE FUNCTION fn_skill_bundle_blobs_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'skill_bundle_blobs is append-only: % forbidden — content is immutable per digest', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_skill_bundle_blobs_append_only ON skill_bundle_blobs;
  CREATE TRIGGER trg_skill_bundle_blobs_append_only BEFORE UPDATE OR DELETE ON skill_bundle_blobs FOR EACH ROW EXECUTE FUNCTION fn_skill_bundle_blobs_append_only();

  CREATE TABLE IF NOT EXISTS skill_revision_files (
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
  );
  CREATE INDEX IF NOT EXISTS skill_revision_files_skill_idx ON skill_revision_files (skill_id);
  CREATE INDEX IF NOT EXISTS skill_revision_files_digest_idx ON skill_revision_files (content_digest);

  CREATE OR REPLACE FUNCTION fn_skill_revision_files_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'skill_revision_files is append-only: % forbidden — record a NEW revision instead', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_skill_revision_files_append_only ON skill_revision_files;
  CREATE TRIGGER trg_skill_revision_files_append_only BEFORE UPDATE OR DELETE ON skill_revision_files FOR EACH ROW EXECUTE FUNCTION fn_skill_revision_files_append_only();

  CREATE TABLE IF NOT EXISTS skill_bundle_heads (
    skill_id text PRIMARY KEY,
    revision_id text NOT NULL,
    bundle_digest text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS skill_bundle_heads_revision_idx ON skill_bundle_heads (revision_id);

  ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS bundle_digest text;
  ALTER TABLE anthropic_skill_sync ADD COLUMN IF NOT EXISTS revision_id text;
  ALTER TABLE anthropic_skill_sync ADD COLUMN IF NOT EXISTS bundle_digest text;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(bundleAuthorityDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible w.r.t. the S1 additions: drop the two fresh tables (+ their
  // trigger/function) and the three added columns. Loses bundle rows + the
  // byte-bound-sync binding by design (empty on a fresh install; a legacy
  // single-blob content authority + content-hash sync remain fully intact — the
  // bundle authority is purely additive over them, so nothing else depends on
  // these objects at S1). A forward fix-migration is the path if bundle data
  // must be preserved.
  pgm.sql(`
    DROP TABLE IF EXISTS skill_bundle_heads;
    DROP TRIGGER IF EXISTS trg_skill_revision_files_append_only ON skill_revision_files;
    DROP FUNCTION IF EXISTS fn_skill_revision_files_append_only();
    DROP TABLE IF EXISTS skill_revision_files;
    DROP TRIGGER IF EXISTS trg_skill_bundle_blobs_append_only ON skill_bundle_blobs;
    DROP FUNCTION IF EXISTS fn_skill_bundle_blobs_append_only();
    DROP TABLE IF EXISTS skill_bundle_blobs;
    ALTER TABLE anthropic_skill_sync DROP COLUMN IF EXISTS bundle_digest;
    ALTER TABLE anthropic_skill_sync DROP COLUMN IF EXISTS revision_id;
    ALTER TABLE skill_revisions DROP COLUMN IF EXISTS bundle_digest;
  `);
}
