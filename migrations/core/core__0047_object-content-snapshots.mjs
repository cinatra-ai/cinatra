// core__0047 — policy-aware content snapshots for claimed typed object rows
// (cinatra#1430, epic #1424).
//
// A typed object row (`@cinatra-ai/campaigns:*`, `@cinatra-ai/email:*`, …)
// becomes context-pinnable by minting an IMMUTABLE JSON snapshot of its
// normalized data at RESOLUTION time. The snapshot is a real
// `representation` revision over a real `blob` `resource` (so the existing
// retention / GC / serve machinery handles it uniformly) plus a keying row
// in `object_content_snapshots` that content-addresses the snapshot by its
// full policy key:
//   (org_id, object_id, content_digest, effective_base_type,
//    snapshot_schema_version, claim_disposition_fingerprint).
// The partial-free UNIQUE index on that tuple is the reuse contract:
//   - identical content re-pinned under the same claim/disposition REUSES
//     the existing representation revision (no duplicate snapshot);
//   - a data change (new content_digest) OR a claimant change (new
//     claim_disposition_fingerprint) mints a FRESH snapshot — a new
//     claimant never reuses another claimant's snapshot.
//
// Additive/NON-destructive: a brand-new table + its indexes only. No column
// retype, no NOT NULL on existing data, no tightened constraint, no data
// rewrite. MIRRORS the idempotent bootstrap DDL in
// src/lib/drizzle-store.ts (buildCreateStoreSchemaQueries) so fresh-bootstrap
// and operator-upgrade stay aligned (core__0034/0041/0043 precedent).
// Unqualified names ride the runner's search_path (the app schema);
// metadata-only DDL, no noTransaction().

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const objectContentSnapshotsDdlSql = `
  CREATE TABLE IF NOT EXISTS object_content_snapshots (
    id                             text PRIMARY KEY,
    org_id                         text NOT NULL,
    object_id                      text NOT NULL,
    content_digest                 text NOT NULL,
    effective_base_type            text NOT NULL,
    snapshot_schema_version        integer NOT NULL,
    claim_disposition_fingerprint  text NOT NULL,
    representation_revision_id     text NOT NULL,
    resource_id                    text NOT NULL,
    size_bytes                     bigint NOT NULL,
    created_by                     text,
    created_at                     timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS object_content_snapshots_key_idx
    ON object_content_snapshots
    (org_id, object_id, content_digest, effective_base_type,
     snapshot_schema_version, claim_disposition_fingerprint);
  CREATE INDEX IF NOT EXISTS object_content_snapshots_object_idx
    ON object_content_snapshots (org_id, object_id);
  CREATE INDEX IF NOT EXISTS object_content_snapshots_resource_idx
    ON object_content_snapshots (org_id, resource_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(objectContentSnapshotsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the keying table. The `representation` / `resource` /
  // `artifact_blobs` rows a snapshot minted are NOT dropped here — they are
  // append-only substance managed by the resource GC (an orphaned snapshot
  // representation simply becomes unpinned and reclaims on retention). Only
  // the keying/reuse index table is this migration's to remove.
  pgm.sql(`DROP TABLE IF EXISTS object_content_snapshots;`);
}
