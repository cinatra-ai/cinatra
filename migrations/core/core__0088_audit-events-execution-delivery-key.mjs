// core__0088 — the EXECUTION-PLANE AUDIT DELIVERY KEY (cinatra#2266 slice 2,
// design gap G4).
//
// WHAT. Two steps against `audit_events`, a table that holds user data on every
// deployed database:
//   1. ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS execution_delivery_key text
//   2. CREATE UNIQUE INDEX IF NOT EXISTS audit_events_execution_delivery_key_key
//        ON audit_events (execution_delivery_key)
//
// WHY A MIGRATION AND NOT BOOTSTRAP DDL ALONE. Step 1 on its own is additive and
// would ride `buildCreateStoreSchemaQueries` happily. Step 2 is not: the
// convention names "a UNIQUE index on an existing table" as destructive
// precisely because it can FAIL on rows that already exist, and `audit_events`
// exists on every deployment. So the pair ships as a numbered migration, and the
// bootstrap DDL is updated in the SAME PR to describe the fresh, post-migration
// shape (a fresh install bootstraps it and ledger-fakes this chain).
//
// WHY IT CANNOT ACTUALLY FAIL ON EXISTING ROWS, stated rather than assumed. The
// column is BRAND NEW, so every pre-existing row has it NULL, and Postgres
// treats NULLs as DISTINCT in a unique index (this is a plain unique index, NOT
// `NULLS NOT DISTINCT`, which would collapse every historical row into one
// conflict). The constraint therefore binds exactly one producer — the execution
// plane, which is the only writer that supplies the column — and no historical
// row can violate it. There is no dedup pass to run because there is nothing to
// dedup.
//
// WHAT THE COLUMN IS. The broker's durable audit spool
// (`packages/execution-plane/src/service/audit-spool.ts`) stamps every record
// with a PHYSICAL delivery identity, `<spoolId>:<recordId>`: `spoolId` is
// persisted per single-writer volume, `recordId` is a spool-local monotonic
// counter allocated at (and surviving) the pre-dispatch reservation. Delivery is
// at-least-once by design — a broker that crashes before its batch is
// acknowledged re-delivers the SAME keys — and this unique index is what makes
// that harmless: the second insert conflicts, the writer reports `duplicate`
// instead of minting a fresh `randomUUID()` row, and one execution yields
// exactly one audit row. It is NOT the logical correlation key
// (`jobId + seq + decision`), which stays in `metadata`; see #2266 G2 for why a
// logical key cannot be the delivery key.
//
// IDEMPOTENT / RE-RUNNABLE. Both statements carry IF (NOT) EXISTS guards, so
// re-running is a no-op — including on a fresh database that bootstrapped the
// post-migration shape and had the chain ledger-faked. Unqualified names ride
// the runner's search_path (the app schema). Metadata-only DDL on a table whose
// writes are short single-row inserts; the index build takes a brief ACCESS
// EXCLUSIVE lock, which is why the module stays in its own transaction rather
// than reaching for CREATE INDEX CONCURRENTLY (which cannot run in one, and
// whose failure mode — a leftover INVALID index — is worse here than a
// sub-second lock on an append-only audit table).
//
// POSTCONDITION (fail-loud). After both steps the module asserts that the column
// AND the unique index exist in the CURRENT schema, so a partial or silently
// skipped apply RAISEs and rolls the transaction back rather than leaving a
// shape the idempotent insert would silently double-write against.
//
// SEQ 0088 — strictly greater than the max seq on live origin/main
// (core__0087_drop-dashboards-visibility) and greater than every seq claimed by
// an open PR at authoring time. Migration seq is assigned at MERGE: a concurrent
// lane may land an intervening seq first, in which case a rename-only renumber
// of this module + its manifest fragment is normal (the runner tolerates
// sequence gaps). migrations/** is HIGH-RISK (owner approval required); the lane
// never merges.
//
// DOWN. Drops the index and the column. Reversible without data loss for every
// OTHER producer (they never wrote the column); the execution plane's delivery
// keys ARE lost, which costs exactly one property: a rollback re-exposes the
// window in which a re-delivered record could write a second row. That is the
// pre-#2266 behaviour, which is what a rollback to a pre-#2266 image asks for.

/** SQL-identifier escaper for an optional schema qualifier (integration path). */
function escId(s) {
  return String(s).replaceAll('"', '""');
}

/**
 * Build the additive column + the unique index it exists for.
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string[]}
 */
export function buildAddDeliveryKeySql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `ALTER TABLE ${t("audit_events")} ADD COLUMN IF NOT EXISTS execution_delivery_key text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS audit_events_execution_delivery_key_key ` +
      `ON ${t("audit_events")} (execution_delivery_key)`,
  ];
}

/**
 * Build the FAIL-LOUD postcondition: the column AND the unique index must exist.
 * @param {string} [schema] optional schema qualifier; defaults to current_schema().
 * @returns {string}
 */
export function buildPostconditionSql(schema) {
  const schemaExpr = schema ? `'${escId(schema).replaceAll("'", "''")}'` : "current_schema()";
  return `DO $core0088$
DECLARE
  col_present bigint;
  idx_present bigint;
BEGIN
  SELECT count(*) INTO col_present
    FROM information_schema.columns
   WHERE table_schema = ${schemaExpr}
     AND table_name   = 'audit_events'
     AND column_name  = 'execution_delivery_key';
  IF col_present = 0 THEN
    RAISE EXCEPTION 'core__0088: audit_events.execution_delivery_key is absent after the add (expected present) — the execution-plane delivery key was not created. Transaction rolled back (no partial apply).';
  END IF;
  SELECT count(*) INTO idx_present
    FROM pg_indexes
   WHERE schemaname = ${schemaExpr}
     AND tablename  = 'audit_events'
     AND indexname  = 'audit_events_execution_delivery_key_key';
  IF idx_present = 0 THEN
    RAISE EXCEPTION 'core__0088: the unique index audit_events_execution_delivery_key_key is absent (expected present) — without it the idempotent execution-audit insert has nothing to conflict on and a re-delivered record would write a SECOND row. Transaction rolled back (no partial apply).';
  END IF;
END
$core0088$`;
}

/**
 * Build the ordered statement list (column → unique index → postcondition).
 * Exposed for the contract test to drive against a real schema.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildUpSql(schema) {
  return [...buildAddDeliveryKeySql(schema), buildPostconditionSql(schema)];
}

/**
 * Build the DOWN (index → column). Idempotent.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const idx = schema
    ? `"${escId(schema)}".audit_events_execution_delivery_key_key`
    : "audit_events_execution_delivery_key_key";
  return [
    `DROP INDEX IF EXISTS ${idx}`,
    `ALTER TABLE ${t("audit_events")} DROP COLUMN IF EXISTS execution_delivery_key`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of buildDownSql()) {
    pgm.sql(`${sql};`);
  }
}
