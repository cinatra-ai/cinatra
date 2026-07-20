// Supplemental live proof for core__0060 (guarded dynamic-types ENGINE teardown, #1793).
//
// Runs the REAL migration's OWN exported SQL (buildGuardSql + buildDropSql, and
// up() via a pgm shim) in ONE transaction against a fresh schema on the verify
// stack, seeding BOTH a dynamic-type registry row AND *living* registered-type
// rows (objects + a live claim), then asserts the acceptance list:
//   - the engine table + its type-definition rows are GONE
//   - NO dangling refs (zero inbound FKs pointed at it; coupling history intact)
//   - LIVING typed rows (registered-type objects + their live claim) UNTOUCHED
//   - idempotent second run is a clean no-op
//
// This is the FOCUSED companion to the DB-gated integration suite
// (src/lib/__tests__/integration/drop-dynamic-object-types.test.ts), which runs
// the same migration up() against the REAL store schema built by
// buildCreateStoreSchemaQueries. Here the coupling tables are hand-built with
// exactly the columns the guards read, so the "living rows untouched / no
// dangling ref" assertions the task calls out are made explicit.
//
// Reproduce (cwd = worktree root; the verify Postgres must be up on :5634):
//   docker exec verify-cinatra-postgres-1 psql -U postgres -c "CREATE DATABASE verify_1793;"
//   SUPABASE_DB_URL="postgres://postgres:postgres@127.0.0.1:5634/verify_1793" \
//     node docs/internals/proofs/1793-teardown/reproduce-teardown-assertions.mjs
//
// The migration module is plain ESM — imported as the real artifact, no copy.
import { Client } from "pg";
import {
  up as dropUp,
  buildGuardSql,
  buildDropSql,
  DYNAMIC_OBJECT_TYPES_TABLE,
} from "../../../../migrations/core/core__0060_drop-dynamic-object-types.mjs";

const CS = process.env.SUPABASE_DB_URL;
const SCHEMA = "verify_1793_supp";
const DYNAMIC_TYPE = "@dynamic/types:competitor-profile";
const REGISTERED_TYPE = "@acme/report-artifact:report"; // a LIVING, registry-declared type
const log = [];
const say = (s) => { log.push(s); console.log(s); };
let failures = 0;
function assert(cond, msg) {
  if (cond) say(`  PASS  ${msg}`);
  else { failures++; say(`  FAIL  ${msg}`); }
}

// Run the migration up() exactly as node-pg-migrate does: pgm.sql() QUEUES text;
// the runner executes the queue in ONE transaction (all-or-nothing).
async function runUp(client) {
  const stmts = [];
  dropUp({ sql: (t) => stmts.push(t) });
  await client.query(`SET search_path TO "${SCHEMA}"`);
  try {
    await client.query("BEGIN");
    try {
      for (const s of stmts) await client.query(s);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
  } finally { await client.query(`SET search_path TO public`); }
}

const reg = async (client, rel) => (await client.query(`SELECT to_regclass($1) AS r`, [`"${SCHEMA}"."${rel}"`])).rows[0].r != null;

async function main() {
  if (!CS) throw new Error("SUPABASE_DB_URL unset");
  const client = new Client({ connectionString: CS });
  await client.connect();
  try {
    say(`# core__0060 supplemental live proof — schema ${SCHEMA} on the verify stack`);
    say(`# migration module: migrations/core/core__0060_drop-dynamic-object-types.mjs (real artifact)`);
    say("");

    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}"`);

    // --- Faithful engine + coupling + object tables (columns the guards read) ---
    await client.query(`CREATE TABLE dynamic_object_types (
      type text PRIMARY KEY, display_name text NOT NULL, inferred_category text NOT NULL,
      status text NOT NULL DEFAULT 'proposed', created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE objects (
      id text PRIMARY KEY, type text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb,
      deleted_at timestamptz)`);
    await client.query(`CREATE TABLE artifact_type_claims (
      id text PRIMARY KEY, scope text NOT NULL, object_type_id text NOT NULL,
      claim_kind text NOT NULL, extension_package text NOT NULL, extension_version text NOT NULL,
      status text NOT NULL)`);
    await client.query(`CREATE TABLE artifact_binding_reconcile_queue (
      id text PRIMARY KEY, scope text NOT NULL, object_type_id text NOT NULL,
      claim_event_id text, kind text NOT NULL, status text NOT NULL)`);
    await client.query(`CREATE TABLE graphiti_projection_outbox (
      id text PRIMARY KEY, object_id text NOT NULL, object_version int NOT NULL,
      operation text NOT NULL, status text NOT NULL)`);
    await client.query(`SET search_path TO public`);

    // --- Seed: a dynamic type (to be dropped with the table) ...
    await client.query(`INSERT INTO "${SCHEMA}".dynamic_object_types (type, display_name, inferred_category, status)
      VALUES ($1,'Competitor profile','profile','active')`, [DYNAMIC_TYPE]);
    // ... plus completed-history coupling over that dynamic type (non-blocking):
    await client.query(`INSERT INTO "${SCHEMA}".artifact_type_claims (id,scope,object_type_id,claim_kind,extension_package,extension_version,status)
      VALUES ('claim-dyn-retired','org:org-1',$1,'default','@vendor/dyn','1.0.0','retired')`, [DYNAMIC_TYPE]);
    await client.query(`INSERT INTO "${SCHEMA}".artifact_binding_reconcile_queue (id,scope,object_type_id,claim_event_id,kind,status)
      VALUES ('q-dyn-done','org:org-1',$1,'ce-1','binding-reconcile','done')`, [DYNAMIC_TYPE]);
    await client.query(`INSERT INTO "${SCHEMA}".objects (id,type) VALUES ('obj-dyn',$1)`, [DYNAMIC_TYPE]);
    await client.query(`INSERT INTO "${SCHEMA}".graphiti_projection_outbox (id,object_id,object_version,operation,status)
      VALUES ('outbox-dyn-done','obj-dyn',1,'upsert','done')`);

    // --- Seed: LIVING registered-type rows that MUST survive untouched ---
    await client.query(`INSERT INTO "${SCHEMA}".objects (id,type,data) VALUES ('obj-live-1',$1,'{"n":1}'::jsonb),('obj-live-2',$1,'{"n":2}'::jsonb)`, [REGISTERED_TYPE]);
    await client.query(`INSERT INTO "${SCHEMA}".artifact_type_claims (id,scope,object_type_id,claim_kind,extension_package,extension_version,status)
      VALUES ('claim-live-active','org:org-1',$1,'default','@acme/report-artifact','2.1.0','active')`, [REGISTERED_TYPE]);
    await client.query(`INSERT INTO "${SCHEMA}".artifact_binding_reconcile_queue (id,scope,object_type_id,claim_event_id,kind,status)
      VALUES ('q-live-pending','org:org-1',$1,'ce-2','binding-reconcile','pending')`, [REGISTERED_TYPE]);

    // Snapshot living rows BEFORE the drop.
    const liveObjsBefore = (await client.query(`SELECT id,type,data FROM "${SCHEMA}".objects WHERE type=$1 ORDER BY id`, [REGISTERED_TYPE])).rows;
    const liveClaimBefore = (await client.query(`SELECT * FROM "${SCHEMA}".artifact_type_claims WHERE object_type_id=$1`, [REGISTERED_TYPE])).rows;
    const liveQueueBefore = (await client.query(`SELECT * FROM "${SCHEMA}".artifact_binding_reconcile_queue WHERE object_type_id=$1`, [REGISTERED_TYPE])).rows;

    // --- No inbound FK points at the engine table (drop orphans nothing structurally) ---
    const inboundFks = (await client.query(
      `SELECT conname FROM pg_constraint con
        JOIN pg_class ref ON ref.oid = con.confrelid
        JOIN pg_namespace ns ON ns.oid = ref.relnamespace
       WHERE con.contype='f' AND ns.nspname=$1 AND ref.relname=$2`, [SCHEMA, DYNAMIC_OBJECT_TYPES_TABLE])).rows;

    say(`## Preconditions (owner-ratified entry-95 guard set), exposed as data by the migration:`);
    for (const s of buildGuardSql(SCHEMA)) say("  guard: " + s.split("\n")[0] + " …");
    say(`## Drop statement: ${buildDropSql(SCHEMA)[0]}`);
    say("");

    say("### Assertions");
    assert(await reg(client, DYNAMIC_OBJECT_TYPES_TABLE), "engine table present before migration");
    assert(inboundFks.length === 0, `no inbound FK targets dynamic_object_types (found ${inboundFks.length}) → drop orphans nothing structurally`);

    // --- RUN the real migration up() in ONE transaction ---
    await runUp(client);
    say("  RUN   migration up() committed (guards a/b/c passed on completed-history-only coupling)");

    // 1. Engine table + its type-definition rows GONE.
    assert(!(await reg(client, DYNAMIC_OBJECT_TYPES_TABLE)), "dynamic_object_types (engine table + its type rows) DROPPED");

    // 2. LIVING registered-type rows UNTOUCHED.
    const liveObjsAfter = (await client.query(`SELECT id,type,data FROM "${SCHEMA}".objects WHERE type=$1 ORDER BY id`, [REGISTERED_TYPE])).rows;
    assert(JSON.stringify(liveObjsAfter) === JSON.stringify(liveObjsBefore) && liveObjsAfter.length === 2,
      `living registered-type objects untouched (${liveObjsAfter.length}/2, byte-identical)`);
    const liveClaimAfter = (await client.query(`SELECT * FROM "${SCHEMA}".artifact_type_claims WHERE object_type_id=$1`, [REGISTERED_TYPE])).rows;
    assert(JSON.stringify(liveClaimAfter) === JSON.stringify(liveClaimBefore) && liveClaimAfter[0]?.status === "active",
      "living registered-type claim untouched (status=active)");
    const liveQueueAfter = (await client.query(`SELECT * FROM "${SCHEMA}".artifact_binding_reconcile_queue WHERE object_type_id=$1`, [REGISTERED_TYPE])).rows;
    assert(JSON.stringify(liveQueueAfter) === JSON.stringify(liveQueueBefore) && liveQueueAfter[0]?.status === "pending",
      "living registered-type reconcile-queue row untouched (status=pending — a LIVE non-dynamic row the guards never inspect)");

    // 3. No dangling refs: dynamic-typed object row + completed-history coupling remain queryable (string keys, not FKs).
    const dynObj = (await client.query(`SELECT id FROM "${SCHEMA}".objects WHERE id='obj-dyn'`)).rows;
    assert(dynObj.length === 1, "dynamic-typed object row remains (object rows are not the engine table; string keys → no DB-level dangling ref)");
    const histClaim = (await client.query(`SELECT status FROM "${SCHEMA}".artifact_type_claims WHERE id='claim-dyn-retired'`)).rows;
    const histQueue = (await client.query(`SELECT status FROM "${SCHEMA}".artifact_binding_reconcile_queue WHERE id='q-dyn-done'`)).rows;
    const histOutbox = (await client.query(`SELECT status FROM "${SCHEMA}".graphiti_projection_outbox WHERE id='outbox-dyn-done'`)).rows;
    assert(histClaim[0]?.status === "retired" && histQueue[0]?.status === "done" && histOutbox[0]?.status === "done",
      "completed-history coupling rows (retired claim / done queue / done outbox) intact — harmless history, no dangling FK");

    // 4. Idempotent second run.
    await runUp(client);
    assert(!(await reg(client, DYNAMIC_OBJECT_TYPES_TABLE)), "idempotent: second up() is a clean no-op (to_regclass NULL → DROP IF EXISTS no-op)");

    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);

    // -----------------------------------------------------------------------
    // GUARD TEETH — each precondition must REFUSE on blocking work and ROLL BACK
    // (the table SURVIVES). Without this, a dropped/weakened guard would still
    // pass the success path above. One blocking case per guard (a/b/c).
    // -----------------------------------------------------------------------
    say("");
    say("### Guard teeth (each guard REFUSES + rolls back on blocking work — table survives)");
    for (const teeth of [
      { id: "a", rx: /precondition \(a\)/,
        seed: `INSERT INTO "${SCHEMA}".artifact_type_claims (id,scope,object_type_id,claim_kind,extension_package,extension_version,status)
               VALUES ('claim-block','org:org-1','${DYNAMIC_TYPE}','default','@vendor/dyn','1.0.0','active')`,
        why: "a non-retired (active) claim over a dynamic type" },
      { id: "b", rx: /precondition \(b\)/,
        seed: `INSERT INTO "${SCHEMA}".artifact_binding_reconcile_queue (id,scope,object_type_id,claim_event_id,kind,status)
               VALUES ('q-block','org:org-1','${DYNAMIC_TYPE}','ce-1','binding-reconcile','pending')`,
        why: "a pending reconcile-queue row for a dynamic type" },
      { id: "c", rx: /precondition \(c\)/,
        seed: `INSERT INTO "${SCHEMA}".objects (id,type) VALUES ('obj-block','${DYNAMIC_TYPE}');
               INSERT INTO "${SCHEMA}".graphiti_projection_outbox (id,object_id,object_version,operation,status)
               VALUES ('outbox-block','obj-block',1,'upsert','processing')`,
        why: "a processing (in-flight) outbox row for a dynamic-typed object" },
    ]) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await client.query(`CREATE SCHEMA "${SCHEMA}"`);
      await client.query(`SET search_path TO "${SCHEMA}"`);
      await client.query(`CREATE TABLE dynamic_object_types (type text PRIMARY KEY, display_name text NOT NULL, inferred_category text NOT NULL, status text NOT NULL DEFAULT 'proposed')`);
      await client.query(`CREATE TABLE objects (id text PRIMARY KEY, type text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb, deleted_at timestamptz)`);
      await client.query(`CREATE TABLE artifact_type_claims (id text PRIMARY KEY, scope text NOT NULL, object_type_id text NOT NULL, claim_kind text NOT NULL, extension_package text NOT NULL, extension_version text NOT NULL, status text NOT NULL)`);
      await client.query(`CREATE TABLE artifact_binding_reconcile_queue (id text PRIMARY KEY, scope text NOT NULL, object_type_id text NOT NULL, claim_event_id text, kind text NOT NULL, status text NOT NULL)`);
      await client.query(`CREATE TABLE graphiti_projection_outbox (id text PRIMARY KEY, object_id text NOT NULL, object_version int NOT NULL, operation text NOT NULL, status text NOT NULL)`);
      await client.query(`SET search_path TO public`);
      await client.query(`INSERT INTO "${SCHEMA}".dynamic_object_types (type, display_name, inferred_category, status) VALUES ('${DYNAMIC_TYPE}','Competitor profile','profile','active')`);
      await client.query(teeth.seed);
      let rejected = null;
      try { await runUp(client); } catch (e) { rejected = e; }
      const survived = await reg(client, DYNAMIC_OBJECT_TYPES_TABLE);
      assert(rejected != null && teeth.rx.test(rejected.message) && survived,
        `guard (${teeth.id}) REFUSES on ${teeth.why} → up() rejects with "precondition (${teeth.id})", tx rolled back, table SURVIVES`);
    }

    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    say("");
    say(failures === 0 ? `RESULT: ALL ${log.filter(l=>l.includes("PASS")).length} SUPPLEMENTAL ASSERTIONS PASSED` : `RESULT: ${failures} FAILURE(S)`);
  } finally { await client.end(); }
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
