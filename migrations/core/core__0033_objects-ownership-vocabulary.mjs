// core__0033 — objects ownership-vocabulary normalization (cinatra#1428,
// epic #1424). ONE-SHOT cutover, no compat window (epic decision 2026-07-12).
//
// WHY. Object saves and artifact reads used DIFFERENT ownership/visibility
// value semantics on the SAME `objects` columns: the objects_save path wrote
// the canonical column model (`owner_level` ∈ user|team|organization|workspace,
// `owner_id`, `visibility` ∈ private|team|organization|public, `project_id`),
// while the artifact write path encoded ownership into composite visibility
// STRINGS ('org', 'workspace', 'team:<id>', 'user:<id>', 'project:<id>') that
// the shared SQL read filter (src/lib/derived-store-ownership.ts) matched
// literally. Each surface was blind to the other's rows. The canonical
// vocabulary is the COLUMN model; this migration normalizes every stored row
// onto it with the FIXED mapping ratified in cinatra#1428, and the same
// change cuts every writer + both read paths over to canonical values.
//
// FIXED MAPPING (composite visibility → column model; the runtime mirror is
// `normalizeOwnershipVocabulary` in src/lib/derived-store-ownership.ts — keep
// the two in lockstep):
//
//   'org'          → owner_level='organization', owner_id=org_id,
//                    visibility='organization'
//   'workspace'    → owner_level='workspace',    visibility='public'
//   'team:<id>'    → owner_level='team', owner_id=<id>, visibility='team'
//   'user:<id>'    → owner_level='user', owner_id=<id>, visibility='private'
//   'project:<id>' → project_id=<id> (kept when already set),
//                    visibility='private' (owner axis untouched — creation
//                    wrote it canonically; sealed-room access now rides the
//                    project_id column)
//
// Plus two residual passes:
//   - legacy lazy-backfill tuples (pass 0, BEFORE the mapping, scoped to rows
//     the mapping does not claim): rows whose `owner_type` (the retired
//     nullable column) disagrees with a still-bare-default `owner_level`
//     adopt owner_type as owner_level (the fixed mapping wins where both
//     apply);
//   - fail-closed catch-all (final pass): any remaining NULL / non-canonical
//     visibility ('owner', 'admin', junk) → 'private' — the same collapse the
//     objects read path's normalizeObjectVisibility applies.
//
// CLASSIFICATION. DESTRUCTIVE (rewrites ownership/visibility values on
// user-land `objects` rows), so this artifact + its manifest fragment are
// REQUIRED by the schema-migration gate. Pure DML — no DDL — so there is
// nothing to mirror into the idempotent bootstrap: a fresh-bootstrap schema
// has no rows to normalize (the chain is ledger-faked there) and all
// post-cutover writers emit canonical values only. Every statement is
// idempotent (canonical rows never match a WHERE), so a re-run is a no-op.
// Runs in the runner's default single transaction via `pgm.db.query` (the
// 0017-precedent form the DB-gated proof suite can drive through its pgm
// shim); unqualified names ride the runner's search_path (the app schema). No index changes: the filter's
// hot predicates ride the existing objects_owner_idx / objects_project_idx /
// objects_org_type_idx.
//
// DOWN. Irreversible by design: the composite originals are not retained and
// canonical rows written BEFORE this migration are indistinguishable from
// normalized ones — any down() would fabricate composite values on rows that
// never carried them. down() throws (one-shot cutover; restore from backup if
// a rollback is ever genuinely required).

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  // ---- Pass 0: legacy lazy-backfill owner_type tuples. Runs FIRST and is
  // scoped to rows the fixed composite mapping below does NOT claim (their
  // visibility is not one of the five composite forms), so the ratified
  // mapping always wins where both apply. Only rows whose owner_level still
  // carries the bare 'organization' column default adopt the recorded
  // owner_type (an explicitly-leveled row is never overridden).
  await pgm.db.query(`
    UPDATE objects
       SET owner_level = owner_type
     WHERE owner_type IN ('user','team','organization','workspace')
       AND owner_type IS DISTINCT FROM owner_level
       AND owner_level = 'organization'
       AND (visibility IS NULL
            OR (visibility NOT IN ('org','workspace')
                AND visibility NOT LIKE 'team:%'
                AND visibility NOT LIKE 'user:%'
                AND visibility NOT LIKE 'project:%'));
  `);

  // ---- Fixed composite mapping (order matters: these fully determine the
  // owner axis + visibility for composite rows).

  // 'org' → organization-owned, org-visible.
  await pgm.db.query(`
    UPDATE objects
       SET owner_level = 'organization',
           owner_id    = COALESCE(org_id, owner_id),
           visibility  = 'organization'
     WHERE visibility = 'org';
  `);

  // 'workspace' → workspace-owned, public (owning-org-wide; the multi-tenant
  // scoping lives in the read filter).
  await pgm.db.query(`
    UPDATE objects
       SET owner_level = 'workspace',
           visibility  = 'public'
     WHERE visibility = 'workspace';
  `);

  // 'team:<id>' → team-owned by <id>, team-visible.
  await pgm.db.query(`
    UPDATE objects
       SET owner_level = 'team',
           owner_id    = substring(visibility from 6),
           visibility  = 'team'
     WHERE visibility LIKE 'team:%'
       AND length(visibility) > 5;
  `);

  // 'user:<id>' → user-owned by <id>, private.
  await pgm.db.query(`
    UPDATE objects
       SET owner_level = 'user',
           owner_id    = substring(visibility from 6),
           visibility  = 'private'
     WHERE visibility LIKE 'user:%'
       AND length(visibility) > 5;
  `);

  // 'project:<id>' → project_id refinement (never clobber an existing
  // project_id — creation-time inheritance already wrote it), private on the
  // share axis; owner columns stay as creation wrote them.
  await pgm.db.query(`
    UPDATE objects
       SET project_id = COALESCE(project_id, substring(visibility from 9)),
           visibility = 'private'
     WHERE visibility LIKE 'project:%'
       AND length(visibility) > 8;
  `);

  // ---- Final pass: fail-closed catch-all. NULL (pre-NOT-NULL-default
  // deployments) and any non-canonical leftover ('owner', 'admin', junk)
  // collapse to 'private' — visible through the owner axes only.
  await pgm.db.query(`
    UPDATE objects
       SET visibility = 'private'
     WHERE visibility IS NULL
        OR visibility NOT IN ('private','team','organization','public');
  `);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function down() {
  throw new Error(
    "core__0033 is a one-shot ownership-vocabulary cutover (cinatra#1428): " +
      "the composite-string originals are not retained and pre-existing " +
      "canonical rows are indistinguishable from normalized ones, so a " +
      "faithful reverse mapping does not exist. Restore from a backup if a " +
      "rollback is genuinely required.",
  );
}
