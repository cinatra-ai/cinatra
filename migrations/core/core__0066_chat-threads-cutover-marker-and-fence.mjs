// core__0066 — PR2 CUTOVER: the drop-history cutover MARKER + the legacy-write
// FENCE on chat_threads, plus the operator-upgrade halves of the structured
// assistant-thread ownership/ordering columns (cinatra-ai/cinatra#1037 P5.6
// drop-history, PR2).
//
// This is the CUTOVER leg of the expand -> cutover -> contract stack. PR1
// (core__0061) added durable per-turn content + structured pause state. Stage-1
// of PR2 added the structured OWNERSHIP/ORDERING axes to the BOOTSTRAP DDL
// (assistant-thread-schema.ts: project_id / team_id / scalars / ordinal + the two
// partial ownership indexes) and cut the /chat READ path over to reconstruct from
// the structured store — but deliberately DEFERRED the operator-upgrade halves of
// those columns to THIS migration, and left the write path DUAL-WRITING (the
// legacy chat_threads INSERT stays; the structured store is populated in lockstep).
//
// This migration carries three things onto the operator upgrade path:
//
//   1. OPERATOR HALVES of the structured columns the bootstrap DDL already
//      provisions on a fresh install (born-with) — so a DEPLOYED database that
//      already has assistant_threads/assistant_turns gains project_id, team_id,
//      origin (+ domain CHECK), scalars (+ object CHECK), ordinal, and the two
//      PARTIAL ownership indexes.
//      Every statement is idempotent (ADD COLUMN IF NOT EXISTS / add-constraint-
//      if-absent / CREATE INDEX IF NOT EXISTS), so re-running against a
//      bootstrap-produced fresh schema (which already has them) is a no-op.
//
//   2. The cutover MARKER: a singleton table `assistant_cutover_marker`. Its
//      PRESENCE (one row) means "the drop-history cutover has happened; the
//      legacy chat_threads write path is retired." This migration creates the
//      table AND SETS the marker row (owner ruling 2026-07-21 final teardown):
//      the write surface is now chat_threads-clean (the legacy INSERT was
//      dropped, the broad chat_thread_* MCP tools + the chat_thread_update
//      project-move UPDATE are retired, and every reader reconstructs from the
//      structured store), so activation is safe. chat_threads itself is dropped
//      in PR3. A DB-observable marker (not app state) is required by the Fork-B
//      design so Postgres — not app code — is the source of truth for "cutover
//      done".
//
//   3. The legacy-write FENCE: a BEFORE INSERT OR UPDATE trigger on chat_threads
//      that RAISEs once the marker exists. Postgres cannot prove app code stopped
//      WRITING chat_threads; this trigger PROVES it — with the marker now SET,
//      any stray legacy chat_threads INSERT/UPDATE fail-closes at the database.
//      (DELETE is unaffected — deleteChatThreadFromDatabase still best-effort
//      cleans a residual legacy row.)
//
// chat_threads is NOT dropped here (PR3) — it is FENCED. This migration installs
// the marker + fence AND activates them; because the write path no longer writes
// chat_threads (INSERT dropped in the read/write cutover), activation is GREEN:
// no product code path performs a fenced INSERT/UPDATE.
//
// GUARDED / IDEMPOTENT (core__0060 + core__0034 pattern). Unqualified names ride
// the runner's search_path (the app schema — the same mechanism that keeps
// per-worktree/branch schemas working). The marker table is CREATE TABLE IF NOT
// EXISTS; constraints are added only when absent (pg_constraint lookup against
// current_schema()); the fence is CREATE OR REPLACE FUNCTION + DROP TRIGGER IF
// EXISTS then CREATE TRIGGER (re-applies cleanly). The fence function body looks
// the marker up in the SAME schema as the fenced table via a dynamic
// `format('… FROM %I.assistant_cutover_marker', TG_TABLE_SCHEMA)` — the schema of
// the table that fired the trigger, NOT an unqualified session-search_path lookup
// (the app writes chat_threads fully schema-qualified and sets no search_path, so
// a bare unqualified reference would resolve against the default path and break
// every write). This function text is identical to the bootstrap DDL copy in
// drizzle-store.ts, so operator and fresh installs converge on the same fence.
//
// down() STRUCTURALLY reverses the DDL (drop the marker-activation row + trigger +
// fence function + marker table + the two ownership indexes + the operator-half
// columns), so a migrate-down before ANY post-cutover write is clean.
//
// ⚠️ ROLLBACK SAFETY (codex convergence, final teardown): this is the CUTOVER leg —
// the legacy chat_threads INSERT is DROPPED and the structured store is now the
// AUTHORITATIVE ownership+ordering metadata; chat_threads is FENCED, no longer
// dual-written. Therefore, once ANY post-cutover write has landed, down() is LOSSY
// — it drops exactly the operator-half columns it added (project_id / team_id /
// origin + CHECK / scalars + CHECK / ordinal) and the marker/fence, discarding
// authoritative metadata with no legacy copy to fall back on. (owner_user_id /
// org_id are stage-1 bootstrap columns, NOT dropped by this down().) down() is a DEV/TEST reverse (and a pre-write operator rollback), NOT a
// production rollback path after the cutover is live: a live-data rollback must first
// re-hydrate chat_threads from the structured store (a data migration, not this DDL
// down()). This matches the expand→cutover→contract doctrine — the cutover leg does
// not carry a clean automatic down once traffic has cut over.

const THREADS = "assistant_threads";
const TURNS = "assistant_turns";
const CHAT_THREADS = "chat_threads";

const PROJECT_COLUMN = "project_id";
const TEAM_COLUMN = "team_id";
const ORIGIN_COLUMN = "origin";
const ORIGIN_CHECK = "assistant_threads_origin_domain_check";
const SCALARS_COLUMN = "scalars";
const SCALARS_CHECK = "assistant_threads_scalars_object_check";
const ORDINAL_COLUMN = "ordinal";

const PROJECT_IDX = "assistant_threads_project_updated_idx";
const TEAM_IDX = "assistant_threads_team_updated_idx";

const MARKER = "assistant_cutover_marker";
const MARKER_SINGLETON_CHECK = "assistant_cutover_marker_singleton";

const FENCE_FN = "fn_chat_threads_legacy_write_fence";
const FENCE_TRG = "trg_chat_threads_legacy_write_fence";

/** Public relation/identifier names (consumed by the shape test + later stages). */
export const CUTOVER_MARKER_TABLE = MARKER;
export const CHAT_THREADS_LEGACY_WRITE_FENCE_FUNCTION = FENCE_FN;
export const CHAT_THREADS_LEGACY_WRITE_FENCE_TRIGGER = FENCE_TRG;

/**
 * Add a constraint only when it is absent, resolved against the runner's
 * search_path (`current_schema()`). Postgres has no `ADD CONSTRAINT IF NOT
 * EXISTS`; mirrors core__0026/core__0061's guarded ALTER. All names are
 * compile-time constants of this module — nothing interpolates runtime input.
 */
function addConstraintIfAbsentSql(table, constraintName, ddl) {
  return `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = '${table}'
      AND c.conname = '${constraintName}'
  ) THEN
    ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ${ddl};
  END IF;
END $$;`;
}

/**
 * Operator-upgrade halves of the structured ownership/ordering columns the
 * bootstrap DDL already provisions on a fresh install: project_id, team_id,
 * scalars (+ object CHECK) on assistant_threads; ordinal on assistant_turns; and
 * the two PARTIAL ownership indexes. Idempotent — a no-op on a fresh schema.
 * Exported as data so the shape test can assert the exact statements. */
export function buildOperatorHalfColumnSql() {
  return [
    `ALTER TABLE ${THREADS} ADD COLUMN IF NOT EXISTS ${PROJECT_COLUMN} text;`,
    `ALTER TABLE ${THREADS} ADD COLUMN IF NOT EXISTS ${TEAM_COLUMN} text;`,
    // Thread-origin DISCRIMINATOR (cinatra#1037 PR2 CUTOVER): 'legacy-chat' vs
    // 'assistant-native' provenance, stamped by both writers. Additive +
    // NULLABLE (no backfill — pre-existing rows carry NULL until their writer
    // re-stamps; the mirror is self-backfilling). The domain CHECK is added
    // only when absent. Scopes the delete-all wipe to the caller's own
    // legacy-chat threads so runtime-native threads survive.
    `ALTER TABLE ${THREADS} ADD COLUMN IF NOT EXISTS ${ORIGIN_COLUMN} text;`,
    addConstraintIfAbsentSql(
      THREADS,
      ORIGIN_CHECK,
      `CHECK (${ORIGIN_COLUMN} IS NULL OR ${ORIGIN_COLUMN} IN ('legacy-chat', 'assistant-native'))`,
    ),
    `ALTER TABLE ${THREADS} ADD COLUMN IF NOT EXISTS ${SCALARS_COLUMN} jsonb;`,
    addConstraintIfAbsentSql(
      THREADS,
      SCALARS_CHECK,
      `CHECK (${SCALARS_COLUMN} IS NULL OR jsonb_typeof(${SCALARS_COLUMN}) = 'object')`,
    ),
    `ALTER TABLE ${TURNS} ADD COLUMN IF NOT EXISTS ${ORDINAL_COLUMN} integer;`,
    `CREATE INDEX IF NOT EXISTS ${PROJECT_IDX} ON ${THREADS} (${PROJECT_COLUMN}, updated_at DESC, id) WHERE ${PROJECT_COLUMN} IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS ${TEAM_IDX} ON ${THREADS} (${TEAM_COLUMN}, updated_at DESC, id) WHERE ${TEAM_COLUMN} IS NOT NULL;`,
  ];
}

/**
 * The cutover MARKER: a singleton table whose presence == "cutover done". The
 * singleton CHECK + boolean PK pin it to at most one row. Exported for the shape
 * test. */
export function buildCutoverMarkerTableSql() {
  return [
    `CREATE TABLE IF NOT EXISTS ${MARKER} (
      id boolean PRIMARY KEY DEFAULT true,
      cutover_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ${MARKER_SINGLETON_CHECK} CHECK (id)
    );`,
  ];
}

/**
 * ACTIVATE the cutover marker (cinatra#1037 P5.6 PR2 CUTOVER final teardown,
 * owner ruling 2026-07-21). Its PRESENCE arms the legacy-write fence below. This
 * migration now SETS the marker because the chat_threads write surface is
 * provably clean: the legacy INSERT was dropped (structured mirror is SOLE
 * writer), the broad chat_thread_* MCP tools + the chat_thread_update
 * project-move UPDATE are retired, and every reader reconstructs from the
 * structured store. Idempotent (ON CONFLICT DO NOTHING on the singleton). Setting
 * the marker is NOT a chat_threads write, so the fence never blocks it. */
export function buildCutoverMarkerActivationSql() {
  return [
    `INSERT INTO ${MARKER} (id) VALUES (true) ON CONFLICT (id) DO NOTHING;`,
  ];
}

/**
 * The legacy-write FENCE: a BEFORE INSERT OR UPDATE trigger on chat_threads that
 * RAISEs once the marker exists. This migration SETS the marker, so the fence is
 * ARMED — every stray legacy chat_threads INSERT/UPDATE fail-closes (DELETE is
 * permitted).
 *
 * The marker is looked up dynamically in the SAME schema as the fenced
 * chat_threads table via `TG_TABLE_SCHEMA` (the schema of the table that fired
 * the trigger, resolved at fire time). This is deliberate: the app writes
 * chat_threads with FULLY SCHEMA-QUALIFIED names and does NOT set a session
 * search_path, so a bare `FROM assistant_cutover_marker` inside the function
 * would resolve against the default search_path (not the app schema) and break
 * every write. `TG_TABLE_SCHEMA` needs no static schema name, so the function
 * text is IDENTICAL in this migration and the bootstrap DDL copy
 * (drizzle-store.ts) — operator and fresh installs converge on one definition.
 *
 * SECURITY DEFINER (codex convergence, stage-2): the trigger fires under whatever
 * role WROTE chat_threads, which is not guaranteed to hold SELECT on the freshly
 * created marker table — a plain SECURITY INVOKER function would then ERROR on the
 * marker lookup and reject EVERY chat_threads write even while the marker is empty.
 * Running as DEFINER executes the lookup as the function OWNER (the migration/
 * bootstrap role that created and owns the marker table), so the read always
 * succeeds and the fence rejects a write ONLY because the marker is set. The marker
 * is fully schema-qualified via TG_TABLE_SCHEMA, so the pinned search_path
 * (pg_catalog, pg_temp — standard DEFINER hardening) cannot redirect the lookup.
 * Exported for the shape test. */
export function buildLegacyWriteFenceSql() {
  return [
    `CREATE OR REPLACE FUNCTION ${FENCE_FN}() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  marker_present boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.${MARKER})', TG_TABLE_SCHEMA) INTO marker_present;
  IF marker_present THEN
    RAISE EXCEPTION 'chat_threads is fenced: the drop-history cutover marker is set — legacy chat_threads % is rejected (cinatra#1037 PR2 CUTOVER)', TG_OP
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$body$;`,
    `DROP TRIGGER IF EXISTS ${FENCE_TRG} ON ${CHAT_THREADS};`,
    `CREATE TRIGGER ${FENCE_TRG} BEFORE INSERT OR UPDATE ON ${CHAT_THREADS} FOR EACH ROW EXECUTE FUNCTION ${FENCE_FN}();`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. Operator-upgrade halves of the structured ownership/ordering columns.
  for (const stmt of buildOperatorHalfColumnSql()) pgm.sql(stmt);
  // 2. The cutover marker singleton table.
  for (const stmt of buildCutoverMarkerTableSql()) pgm.sql(stmt);
  // 3. The legacy-write fence on chat_threads (keys off the marker).
  for (const stmt of buildLegacyWriteFenceSql()) pgm.sql(stmt);
  // 4. ACTIVATE the marker — arms the fence. The write surface is chat_threads-
  //    clean (INSERT dropped, chat_thread_* tools + project-move UPDATE retired,
  //    readers reconstruct from the structured store), so every post-cutover
  //    legacy chat_threads INSERT/UPDATE now fail-closes at the database.
  for (const stmt of buildCutoverMarkerActivationSql()) pgm.sql(stmt);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // STRUCTURAL reverse, dependency order: trigger + function, then the marker
  // table (drops the activation row with it), then the ownership indexes +
  // operator-half columns. NOTE (rollback safety): post-cutover the structured
  // columns are AUTHORITATIVE and chat_threads is fenced/no-longer-dual-written,
  // so this down() is LOSSY once any post-cutover write has landed — it is a
  // dev/test + pre-write reverse, not a production rollback (see the header).
  pgm.sql(`DROP TRIGGER IF EXISTS ${FENCE_TRG} ON ${CHAT_THREADS};`);
  pgm.sql(`DROP FUNCTION IF EXISTS ${FENCE_FN}();`);
  pgm.sql(`DROP TABLE IF EXISTS ${MARKER};`);
  pgm.sql(`DROP INDEX IF EXISTS ${TEAM_IDX};`);
  pgm.sql(`DROP INDEX IF EXISTS ${PROJECT_IDX};`);
  pgm.sql(`ALTER TABLE ${TURNS} DROP COLUMN IF EXISTS ${ORDINAL_COLUMN};`);
  pgm.sql(`ALTER TABLE ${THREADS} DROP CONSTRAINT IF EXISTS ${SCALARS_CHECK};`);
  pgm.sql(`ALTER TABLE ${THREADS} DROP COLUMN IF EXISTS ${SCALARS_COLUMN};`);
  pgm.sql(`ALTER TABLE ${THREADS} DROP CONSTRAINT IF EXISTS ${ORIGIN_CHECK};`);
  pgm.sql(`ALTER TABLE ${THREADS} DROP COLUMN IF EXISTS ${ORIGIN_COLUMN};`);
  pgm.sql(`ALTER TABLE ${THREADS} DROP COLUMN IF EXISTS ${TEAM_COLUMN};`);
  pgm.sql(`ALTER TABLE ${THREADS} DROP COLUMN IF EXISTS ${PROJECT_COLUMN};`);
}
