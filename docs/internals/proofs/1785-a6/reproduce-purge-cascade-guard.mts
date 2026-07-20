// LIVE seeded-fixture proof of core__0059 (wave A6): the purge cascade + the
// trigger-bypass + the reachability delegation + the DB write-guard, executed
// against the REAL store schema (built by buildCreateStoreSchemaQueries) on the
// verify Postgres, running the migration's OWN exported SQL builders.
//
// Fixture: a RETIRED generic floor artifact R (@cinatra-ai/artifact:object) with
// full lineage across every cascade table + histories, a LIVING pack-typed
// artifact L (@cinatra-ai/pdf:document) with its own lineage sharing a resource,
// an uninstall op shared by R+L, change_sets that are retired-only / mixed /
// living-only, and a surviving child object parented at R.
import { Client } from "pg";
import {
  buildPurgeSql,
  buildGenericWriteGuardSql,
  RETIRED_GENERIC_ARTIFACT_TYPE,
} from "../../../../migrations/core/core__0059_purge-default-artifact-floor.mjs";

const CS = "postgres://postgres:postgres@127.0.0.1:5634/prove_1785_purge";
const c = new Client({ connectionString: CS });
await c.connect();
await c.query(`SET search_path TO cinatra, public`);

const R = "obj-retired";
const L = "obj-living";
const CHILD = "obj-child";
const RT = RETIRED_GENERIC_ARTIFACT_TYPE; // @cinatra-ai/artifact:object
const LT = "@cinatra-ai/pdf:document";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
const q = async (sql: string, vals?: unknown[]) => (await c.query(sql, vals)).rows;
const count = async (sql: string, vals?: unknown[]) =>
  Number((await c.query(`SELECT count(*)::int n FROM (${sql}) s`, vals)).rows[0].n);

// ---- reset any prior run's rows (idempotent proof; app-integrity graph = no FK cascade) ----
const allSeedTables = [
  "objects","resource","representation","artifact_audit","artifact_refs","artifact_provider_cache",
  "artifact_materializations","artifact_publication_operations","semantic_assertion","run_context_selections",
  "object_content_snapshots","graphiti_projection_outbox","merge_proposal","artifact_promotion_request",
  "artifact_binding_reconcile_queue","object_binding_quarantine","artifact_uninstall_operations",
  "artifact_uninstall_operation_assertions","change_set","object_change_event","remote_effect_attempts",
];
// disable the append-only triggers only for the TRUNCATE reset (they RAISE on delete)
for (const t of allSeedTables) await c.query(`TRUNCATE TABLE ${t} CASCADE`).catch(() => {});
// Model the PRE-migration state: the write-guard the purge installs must NOT
// exist yet, else seeding the legacy generic fixture (the exact rows the purge
// targets) is itself refused. buildGenericWriteGuardSql re-creates it below.
await c.query(`DROP TRIGGER IF EXISTS trg_objects_reject_retired_generic_type ON objects`).catch(() => {});
await c.query(`DROP FUNCTION IF EXISTS fn_objects_reject_retired_generic_type()`).catch(() => {});

// Drop the single convenience FK (object graph is app-integrity; purge is FK-agnostic).
await c.query(
  `ALTER TABLE authoring_step_artifacts DROP CONSTRAINT IF EXISTS authoring_step_artifacts_authoring_step_id_fkey`,
).catch(() => {});

// ------------------------------------------------------------------ SEED
async function seed() {
  // objects: R (retired), L (living), CHILD (living, parented at R)
  await q(`INSERT INTO objects(id,type,data,org_id) VALUES ($1,$2,'{}',$4),($3,$5,'{}',$4)`, [R, RT, L, "org1", LT]);
  await q(`INSERT INTO objects(id,type,data,org_id,parent_id,parent_type) VALUES ($1,$2,'{}','org1',$3,$2)`, [CHILD, LT, R]);

  // shared resource (reachability-delegated: must survive the purge)
  await q(
    `INSERT INTO resource(id,org_id,kind,substance_key,mime) VALUES ('res-shared','org1','blob','sha256:shared','application/pdf')`,
  );

  // representation (trigger-guarded, artifact_id) for R and L, both pinning res-shared
  await q(
    `INSERT INTO representation(id,org_id,artifact_id,resource_id,revision,form) VALUES
       ('rep-R','org1',$1,'res-shared',1,'file'),
       ('rep-L','org1',$2,'res-shared',1,'file')`,
    [R, L],
  );

  // artifact_id-keyed children (non-trigger) for R and L
  await q(`INSERT INTO artifact_audit(id,org_id,artifact_id,action) VALUES ('aa-R','org1',$1,'created'),('aa-L','org1',$2,'created')`, [R, L]);
  await q(`INSERT INTO artifact_refs(id,org_id,artifact_id,representation_revision_id,digest,mime,origin_kind,referrer_kind,referrer_id) VALUES
       ('ar-R','org1',$1,'rep-R','sha256:shared','application/pdf','upload','message','m1'),
       ('ar-L','org1',$2,'rep-L','sha256:shared','application/pdf','upload','message','m2')`, [R, L]);
  await q(`INSERT INTO artifact_provider_cache(id,org_id,artifact_id,representation_revision_id,digest,provider,provider_file_id,mime) VALUES
       ('pc-R','org1',$1,'rep-R','sha256:shared','openai','file_R','application/pdf')`, [R]);
  await q(`INSERT INTO artifact_materializations(id,org_id,run_id,output_id,path,extension,content_hash,artifact_id) VALUES
       ('mat-R','org1','run1','out1','materialize_tool','pdf','sha256:shared',$1)`, [R]);
  await q(`INSERT INTO artifact_publication_operations(id,org_id,artifact_id,object_type_id,pinned_representation_revision_id,destination_connector,due_at,idempotency_key) VALUES
       ('pub-R','org1',$1,$2,'rep-R','gdrive',now(),'idem-R')`, [R, RT]);
  await q(`INSERT INTO semantic_assertion(id,org_id,artifact_id,extension,asserted_by,eligibility) VALUES
       ('sa-R','org1',$1,'@cinatra-ai/artifact','system','eligible'),
       ('sa-L','org1',$2,'@cinatra-ai/pdf','system','eligible')`, [R, L]);

  // trigger-guarded run_context_selections (artifact_id) for R and L
  await q(`INSERT INTO run_context_selections(id,org_id,parent_run_id,parent_package_name,slot_id,artifact_id,representation_revision_id,semantic_assertion_id,extension,source_scope,selected_by,selection_mode) VALUES
       ('rcs-R','org1','run1','@pkg','slot1',$1,'rep-R','sa-R','@cinatra-ai/artifact','user','user','autonomous'),
       ('rcs-L','org1','run1','@pkg','slot2',$2,'rep-L','sa-L','@cinatra-ai/pdf','user','user','autonomous')`, [R, L]);

  // object_id-keyed children (core__0056 set) for R
  await q(`INSERT INTO object_content_snapshots(id,org_id,object_id,content_digest,effective_base_type,snapshot_schema_version,claim_disposition_fingerprint,representation_revision_id,resource_id,size_bytes) VALUES
       ('ocs-R','org1',$1,'sha256:shared',$2,1,'fp','rep-R','res-shared',10)`, [R, RT]);
  await q(`INSERT INTO graphiti_projection_outbox(object_id,object_version,operation) VALUES ($1,1,'upsert')`, [R]);
  await q(`INSERT INTO merge_proposal(id,object_id,object_type,base_version,source_kind,proposed_fields) VALUES ('mp-R',$1,$2,1,'agent','{}')`, [R, RT]);
  await q(`INSERT INTO artifact_promotion_request(id,org_id,object_id,object_title,requested_by,from_visibility,to_visibility,to_owner_level,to_owner_id,row_version) VALUES
       ('apr-R','org1',$1,'T','u1','private','organization','organization','org1',1)`, [R]);
  await q(`INSERT INTO artifact_binding_reconcile_queue(scope,object_type_id,kind,object_id,org_id) VALUES ('org',$2,'binding-reconcile-write',$1,'org1')`, [R, RT]);
  await q(`INSERT INTO object_binding_quarantine(org_id,object_id,object_type_id,reason) VALUES ('org1',$1,$2,'x')`, [R, RT]);

  // uninstall operations: uop-retired (R only → swept), uop-shared (R + L → survives)
  await q(`INSERT INTO artifact_uninstall_operations(id,scope,extension_package,extension_version,actor) VALUES
       ('uop-retired','org:org1','@cinatra-ai/default-artifact','1.0.0','u1'),
       ('uop-shared','org:org1','@cinatra-ai/default-artifact','1.0.0','u1')`);
  await q(`INSERT INTO artifact_uninstall_operation_assertions(id,operation_id,assertion_id,org_id,artifact_id,extension,asserted_by) VALUES
       ('uoa-R','uop-retired','sa-R','org1',$1,'@cinatra-ai/artifact','matcher'),
       ('uoa-Rs','uop-shared','sa-R','org1',$1,'@cinatra-ai/artifact','matcher'),
       ('uoa-Ls','uop-shared','sa-L','org1',$2,'@cinatra-ai/pdf','matcher')`, [R, L]);

  // history: change_sets + events. cs-retired-only (R only → swept), cs-mixed (R+L → survives), cs-living-only (L only → survives)
  await q(`INSERT INTO change_set(id,org_id) VALUES ('cs-retired-only','org1'),('cs-mixed','org1'),('cs-living-only','org1')`);
  await q(`INSERT INTO object_change_event(id,change_set_id,sequence,object_id,object_type,operation,history_effect,result_version,idempotency_key,event_checksum) VALUES
       ('oce-R1','cs-retired-only',1,$1,$3,'create','append',1,'i1','k1'),
       ('oce-R2','cs-mixed',1,$1,$3,'update','append',2,'i2','k2'),
       ('oce-L1','cs-mixed',2,$2,$4,'create','append',1,'i3','k3'),
       ('oce-L2','cs-living-only',1,$2,$4,'update','append',2,'i4','k4')`, [R, L, RT, LT]);
  // remote_effect_attempts hang off R's change events (must be deleted before the events)
  await q(`INSERT INTO remote_effect_attempts(id,change_event_id,connector_name,target_kind,idempotency_key) VALUES
       ('rea-R','oce-R1','gdrive','file','ri1')`);
}

await seed();

// ------------------------------------------------------- DRY-RUN (pre-counts)
const pre = {
  retiredObjects: await count(`SELECT 1 FROM objects WHERE type=$1`, [RT]),
  livingObjects: await count(`SELECT 1 FROM objects WHERE type=$1`, [LT]),
  Rrep: await count(`SELECT 1 FROM representation WHERE artifact_id=$1`, [R]),
  Rrcs: await count(`SELECT 1 FROM run_context_selections WHERE artifact_id=$1`, [R]),
  Ruoa: await count(`SELECT 1 FROM artifact_uninstall_operation_assertions WHERE artifact_id=$1`, [R]),
  Revents: await count(`SELECT 1 FROM object_change_event WHERE object_id=$1`, [R]),
  Rrea: await count(`SELECT 1 FROM remote_effect_attempts WHERE change_event_id IN (SELECT id FROM object_change_event WHERE object_id=$1)`, [R]),
};

const purgeStmts = buildPurgeSql();
const guardStmts = buildGenericWriteGuardSql();

console.log("================ DRY-RUN: statements the purge WILL execute ================");
purgeStmts.forEach((s, i) => console.log(`[${String(i).padStart(2, "0")}] ${s.replace(/\s+/g, " ").trim()}`));
console.log("\n---------------- DRY-RUN: rows that WILL be purged (pre-counts) -------------");
console.log(pre);

// ------------------------------------------------------- REAL RUN
console.log("\n================ REAL RUN: executing buildPurgeSql() + guard (single tx, as up() does) =================");
await c.query("BEGIN");
for (const s of purgeStmts) await c.query(s);
for (const s of guardStmts) await c.query(s);
await c.query("COMMIT");
console.log(`executed ${purgeStmts.length} purge stmts + ${guardStmts.length} guard stmts in ONE transaction`);

// ------------------------------------------------------- POST ASSERTIONS
// (1) RETIRED fully gone
check("retired objects gone", (await count(`SELECT 1 FROM objects WHERE type=$1`, [RT])) === 0);
const artifactIdChildren = ["artifact_audit","artifact_refs","artifact_provider_cache","artifact_materializations","artifact_publication_operations","semantic_assertion","representation","run_context_selections","artifact_uninstall_operation_assertions"];
for (const t of artifactIdChildren) {
  check(`${t}: no R rows`, (await count(`SELECT 1 FROM ${t} WHERE artifact_id=$1`, [R])) === 0);
}
const objectIdChildren = ["object_content_snapshots","graphiti_projection_outbox","merge_proposal","artifact_promotion_request","artifact_binding_reconcile_queue","object_binding_quarantine"];
for (const t of objectIdChildren) {
  check(`${t}: no R rows`, (await count(`SELECT 1 FROM ${t} WHERE object_id=$1`, [R])) === 0);
}
check("R change events gone", (await count(`SELECT 1 FROM object_change_event WHERE object_id=$1`, [R])) === 0);
check("R remote_effect_attempts gone", (await count(`SELECT 1 FROM remote_effect_attempts WHERE id='rea-R'`)) === 0);

// (2) orphan sweeps
check("uop-retired swept (zero-assertion, purge-touched)", (await count(`SELECT 1 FROM artifact_uninstall_operations WHERE id='uop-retired'`)) === 0);
check("cs-retired-only swept (no remaining events)", (await count(`SELECT 1 FROM change_set WHERE id='cs-retired-only'`)) === 0);

// (3) LIVING intact
check("living object L present", (await count(`SELECT 1 FROM objects WHERE id=$1`, [L])) === 1);
check("L representation intact", (await count(`SELECT 1 FROM representation WHERE artifact_id=$1`, [L])) === 1);
check("L artifact_refs intact", (await count(`SELECT 1 FROM artifact_refs WHERE artifact_id=$1`, [L])) === 1);
check("L semantic_assertion intact", (await count(`SELECT 1 FROM semantic_assertion WHERE artifact_id=$1`, [L])) === 1);
check("L run_context_selections intact", (await count(`SELECT 1 FROM run_context_selections WHERE artifact_id=$1`, [L])) === 1);
check("uop-shared SURVIVES (still has L's assertion)", (await count(`SELECT 1 FROM artifact_uninstall_operations WHERE id='uop-shared'`)) === 1);
check("uop-shared L assertion intact", (await count(`SELECT 1 FROM artifact_uninstall_operation_assertions WHERE id='uoa-Ls'`)) === 1);
check("uop-shared R assertion removed", (await count(`SELECT 1 FROM artifact_uninstall_operation_assertions WHERE id='uoa-Rs'`)) === 0);
check("cs-mixed SURVIVES (living event kept)", (await count(`SELECT 1 FROM change_set WHERE id='cs-mixed'`)) === 1);
check("cs-living-only SURVIVES", (await count(`SELECT 1 FROM change_set WHERE id='cs-living-only'`)) === 1);
check("L change events intact (2)", (await count(`SELECT 1 FROM object_change_event WHERE object_id=$1`, [L])) === 2);

// (4) nothing dangles: surviving child's parent NULLed, no dangling child refs anywhere
const childRow = (await q(`SELECT parent_id, parent_type FROM objects WHERE id=$1`, [CHILD]))[0];
check("surviving CHILD present with parent_id NULLed", !!childRow && childRow.parent_id === null && childRow.parent_type === null, JSON.stringify(childRow));
let dangling = 0;
for (const t of artifactIdChildren) dangling += await count(`SELECT 1 FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.id=x.artifact_id)`);
for (const t of objectIdChildren) dangling += await count(`SELECT 1 FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.id=x.object_id)`);
check("no dangling artifact_id/object_id child references anywhere", dangling === 0, `dangling=${dangling}`);

// (5) shared physical storage untouched (reachability delegated)
check("shared resource row untouched", (await count(`SELECT 1 FROM resource WHERE id='res-shared'`)) === 1);

// (6) DB write-guard
async function expectRaise(label: string, sql: string, vals?: unknown[]) {
  try {
    await c.query(sql, vals);
    check(label, false, "NO error raised (guard did not fire)");
  } catch (e) {
    check(label, /RETIRED generic Default Artifact floor/.test((e as Error).message), (e as Error).message.split("\n")[0]);
  }
}
await expectRaise("guard REJECTS new generic INSERT", `INSERT INTO objects(id,type,data) VALUES ('g-new',$1,'{}')`, [RT]);
await expectRaise("guard REJECTS UPDATE to generic type", `UPDATE objects SET type=$1 WHERE id=$2`, [RT, L]);
try {
  await c.query(`INSERT INTO objects(id,type,data,org_id) VALUES ('g-ok',$1,'{}','org1')`, [LT]);
  check("guard ALLOWS a valid pack-typed INSERT", true);
  await c.query(`DELETE FROM objects WHERE id='g-ok'`);
} catch (e) {
  check("guard ALLOWS a valid pack-typed INSERT", false, (e as Error).message.split("\n")[0]);
}

// (7) idempotency: a SECOND purge run matches nothing and does not error
try {
  await c.query("BEGIN");
  for (const s of buildPurgeSql()) await c.query(s);
  await c.query("COMMIT");
  check("second purge run is a clean no-op (idempotent)", (await count(`SELECT 1 FROM objects WHERE type=$1`, [RT])) === 0 && (await count(`SELECT 1 FROM objects WHERE id=$1`, [L])) === 1);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  check("second purge run is a clean no-op (idempotent)", false, (e as Error).message.split("\n")[0]);
}

// ------------------------------------------------------- REPORT
console.log("\n================ PROOF ASSERTIONS ================");
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
  if (r.ok) pass += 1;
}
console.log(`\n${pass}/${results.length} assertions passed`);
await c.end();
if (pass !== results.length) process.exit(1);
