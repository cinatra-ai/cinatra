// Real-DB integration proof for the binding-assertion write path + per-claim
// activation gate (cinatra#1429, epic #1424). Runs against a live Postgres
// (SUPABASE_DB_URL / SUPABASE_SCHEMA) — excluded from the fast `test:root`
// suite (root vitest excludes **/*.integration.test.ts). Each of the 5 epic
// ACs is exercised end-to-end against real DDL + constraints.

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The full app bootstrap references Supabase-only tables (public.user) absent
// on a plain verify Postgres, so we no-op ensurePostgresSchema and build ONLY
// the tables this slice needs (minimal objects/outbox/installed_extension + the
// merged assertion/claim leaves + the cinatra#1429 support leaf).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { semanticAssertionSchemaQueries } from "@/lib/semantic-assertion-schema";
// artifactClaimSchemaQueries now also spreads the cinatra#1429 binding
// write-path support (quarantine + backfill checkpoint tables + the
// asserted_by='system' CHECK widening).
import { artifactClaimSchemaQueries } from "@/lib/artifact-claim-schema";

import {
  activateArtifactTypeClaim,
  beginArtifactTypeClaimRetirement,
  finalizeArtifactTypeClaimRetirement,
  readArtifactTypeClaimsForExtension,
  reserveArtifactTypeClaim,
} from "@/lib/objects/artifact-claim-store";
import {
  reconcileArtifactBinding,
  reconcileArtifactBindingForWrite,
  readActiveBinding,
} from "@/lib/objects/binding-write-path";
import {
  buildAssertSemanticTypeQueries,
  buildFloorRebalanceAndRefreshQueries,
} from "@/lib/artifacts/semantic-assertion-store";
import {
  processBindingReconcileQueue,
  reconcileTypeBindings,
  runBindingBackfill,
} from "@/lib/objects/binding-reconcile-sweep";
import {
  ClaimNotActivatableError,
  InvalidActivatedTypePayloadError,
  assertActivatedTypePayloadValid,
  assertClaimActivatable,
  isObjectQuarantined,
  quarantineObject,
} from "@/lib/objects/claim-activation-gate";

const S = () => postgresSchema.replaceAll('"', '""');
let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Seed an object row of a given type. */
function seedObject(input: { id: string; type: string; orgId: string; data?: unknown }) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization')`,
    [input.id, input.type, input.orgId, JSON.stringify(input.data ?? {})],
  );
}

function setObjectType(id: string, type: string) {
  sql(`UPDATE "${S()}"."objects" SET type = $2, version = version + 1 WHERE id = $1`, [id, type]);
}

/** Reserve + activate a dedicated claim; returns its id + generation. */
function seedDedicatedClaim(input: {
  scope: string;
  type: string;
  pkg: string;
}): { id: string; generation: number } {
  const id = reserveArtifactTypeClaim({
    scope: input.scope,
    objectTypeId: input.type,
    claimKind: "dedicated",
    extensionPackage: input.pkg,
    extensionVersion: "1.0.0",
    installId: null,
    dispositions: { projection: "artifact-safe", pinnable: false },
    actor: "system",
  });
  activateArtifactTypeClaim({ claimId: id, actor: "system" });
  const r = sql(`SELECT generation FROM "${S()}"."artifact_type_claims" WHERE id = $1`, [id]);
  return { id, generation: Number(r.rows[0].generation) };
}

/** Also register a live installed_extension row so the effective-identity
 * resolver (which requires an INSTALLED extension) recognizes the winner. */
function seedInstalledArtifactExtension(pkg: string, orgId: string | null) {
  const id = nextId("inst");
  sql(
    `INSERT INTO "${S()}"."installed_extension" (id, package_name, kind, status, organization_id)
     VALUES ($1,$2,'artifact','active',$3)
     ON CONFLICT DO NOTHING`,
    [id, pkg, orgId],
  );
}

function activeBindingCount(orgId: string, artifactId: string): number {
  const r = sql(
    `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
     WHERE org_id=$1 AND artifact_id=$2 AND assertion_basis='binding' AND eligibility<>'archived'`,
    [orgId, artifactId],
  );
  return Number(r.rows[0].n);
}

function floorAssertionCount(orgId: string, artifactId: string): number {
  const r = sql(
    `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
     WHERE org_id=$1 AND artifact_id=$2 AND extension='@cinatra-ai/default-artifact' AND eligibility<>'archived'`,
    [orgId, artifactId],
  );
  return Number(r.rows[0].n);
}

function exec(text: string) {
  runPostgresQueriesSync({ connectionString: getPostgresConnectionString(), queries: [{ text }] });
}

beforeAll(() => {
  const s = S();
  exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  // Minimal objects (superset of the columns the reconcile/floor/seed touch).
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."objects" (
    id text PRIMARY KEY, type text NOT NULL, parent_id text, parent_type text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), created_by text, org_id text,
    source text, version integer NOT NULL DEFAULT 1,
    graphiti_sync_status text DEFAULT 'pending', graphiti_projection_error text,
    owner_level text, owner_id text, visibility text, project_id text,
    deleted_at timestamptz )`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."graphiti_projection_outbox" (
    id text PRIMARY KEY, object_id text NOT NULL, object_version integer NOT NULL,
    org_id text, operation text NOT NULL, payload_hash text,
    status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now() )`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."installed_extension" (
    id text PRIMARY KEY, package_name text NOT NULL, kind text NOT NULL,
    status text NOT NULL, organization_id text )`);
  // Merged leaves + the cinatra#1429 support leaf (creates semantic_assertion
  // with the widened asserted_by CHECK, the claim registry + reconcile queue,
  // and the quarantine + backfill-checkpoint tables).
  for (const query of [
    ...semanticAssertionSchemaQueries(postgresSchema),
    ...artifactClaimSchemaQueries(postgresSchema),
  ]) {
    exec(query.text);
  }
});

describe("cinatra#1429 — binding write path (real DB)", () => {
  it("core__0040: asserted_by CHECK admits 'system'; a binding row inserts", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const pkg = `@vendor/${type.split("/")[1].split(":")[0]}-artifact`;
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    const claim = seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg });

    const res = reconcileArtifactBinding({ orgId, artifactId });
    expect(res.inserted).toBe(1);
    const b = readActiveBinding(orgId, artifactId);
    expect(b?.extension).toBe(pkg);
    expect(b?.bindingClaimId).toBe(claim.id);
    expect(b?.bindingGeneration).toBe(claim.generation);
    const row = sql(
      `SELECT asserted_by FROM "${S()}"."semantic_assertion" WHERE id=$1`,
      [b!.id],
    );
    expect(row.rows[0].asserted_by).toBe("system");
  });

  it("reconcile is idempotent: a matching binding inserts nothing on re-run", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const pkg = "@vendor/x-artifact";
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg });

    expect(reconcileArtifactBinding({ orgId, artifactId }).inserted).toBe(1);
    const again = reconcileArtifactBinding({ orgId, artifactId });
    expect(again.inserted).toBe(0);
    expect(again.archived).toBe(0);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  });

  it("floor scoping: the floor rebalance adds a default to a GENERIC artifact row but NOT to a typed row", () => {
    const orgId = nextId("org");
    // Re-qualify the real builder's SQL to the isolated test schema (vitest can
    // give semantic-assertion-store a separately-evaluated schema binding; this
    // still exercises the EXACT builder output against real DDL).
    const reQualify = (t: string) =>
      t.replace(/"[a-z_0-9]+"\.("semantic_assertion"|"objects"|"graphiti_projection_outbox"|"artifact_type_claims")/g, (_m, tbl) => `"${S()}".${tbl}`);
    const runFloor = (artifactId: string) =>
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        transaction: true,
        queries: [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [artifactId] },
          ...buildFloorRebalanceAndRefreshQueries(orgId, artifactId, "agent").map((qy) => ({
            text: reQualify(qy.text),
            values: qy.values,
          })),
        ],
      });

    // Generic artifact row → floor default IS inserted (unchanged behavior).
    const generic = nextId("obj");
    seedObject({ id: generic, type: "@cinatra-ai/artifact:object", orgId });
    runFloor(generic);
    expect(floorAssertionCount(orgId, generic)).toBe(1);

    // Dedicated-claimed typed row → floor default is NEVER inserted.
    const typedId = nextId("obj");
    const type = `@vendor/${nextId("pkg")}:thing`;
    seedObject({ id: typedId, type, orgId });
    seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg: "@vendor/y-artifact" });
    runFloor(typedId);
    expect(floorAssertionCount(orgId, typedId)).toBe(0);
    reconcileArtifactBinding({ orgId, artifactId: typedId });
    // Re-running the floor after a binding lands still adds nothing.
    runFloor(typedId);
    expect(floorAssertionCount(orgId, typedId)).toBe(0);
    expect(activeBindingCount(orgId, typedId)).toBe(1);
  });

  it("AC-1: sa_one_active_binding_idx rejects a second active binding (≤1 under any race)", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg: "@vendor/z-artifact" });
    reconcileArtifactBinding({ orgId, artifactId });
    expect(() =>
      sql(
        `INSERT INTO "${S()}"."semantic_assertion"
          (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
         VALUES ($1,$2,$3,'@vendor/other','system','eligible','binding','fake-claim',1)`,
        [nextId("sa"), orgId, artifactId],
      ),
    ).toThrow(/sa_one_active_binding_idx|duplicate key/);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  });

  it("AC-1 (real concurrency): the per-artifact advisory lock serializes overlapping binding writes → exactly one binding, no deadlock", async () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    const claim = seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg: "@vendor/conc-artifact" });

    const schema = S();
    const reconcileTx = async (client: Client) => {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [artifactId]);
      // Insert the winner's binding if none active matches (mirror of the
      // reconcile insert), then a short delay to widen the overlap window.
      await client.query(
        `INSERT INTO "${schema}"."semantic_assertion"
           (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
         SELECT $1,$2,$3,'@vendor/conc-artifact','system','eligible','binding',$4,$5
         WHERE NOT EXISTS (
           SELECT 1 FROM "${schema}"."semantic_assertion"
           WHERE org_id=$2 AND artifact_id=$3 AND assertion_basis='binding' AND eligibility<>'archived')`,
        [`sa-${Math.random()}`, orgId, artifactId, claim.id, claim.generation],
      );
      await new Promise((r) => setTimeout(r, 150));
      await client.query("COMMIT");
    };

    const c1 = new Client({ connectionString: getPostgresConnectionString() });
    const c2 = new Client({ connectionString: getPostgresConnectionString() });
    await c1.connect();
    await c2.connect();
    try {
      // Both racing on the same artifact lock; the second waits for the first's
      // COMMIT (no deadlock, single lock).
      await Promise.all([reconcileTx(c1), reconcileTx(c2)]);
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  }, 20000);

  it("AC-2: a winner change reconciles from live DB state — the stale binding is never served", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const artifactId = nextId("obj");
    const pkgPlatform = "@vendor/platform-artifact";
    const pkgOrg = "@vendor/org-artifact";
    seedObject({ id: artifactId, type, orgId });
    seedInstalledArtifactExtension(pkgPlatform, null);
    seedInstalledArtifactExtension(pkgOrg, orgId);

    const platformClaim = seedDedicatedClaim({ scope: "platform", type, pkg: pkgPlatform });
    reconcileArtifactBinding({ orgId, artifactId });
    expect(readActiveBinding(orgId, artifactId)?.bindingClaimId).toBe(platformClaim.id);

    // Winner change: an org-scoped dedicated claim outranks the platform one and
    // enqueues a binding-reconcile queue row.
    const orgClaim = seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg: pkgOrg });

    // Drain the queue → binding reconciles to the org winner. (Under epic #1785
    // the binding write path is KEPT plumbing; effective identity is now
    // type-driven and no longer reads bindings, so the reconciliation is
    // verified via the live binding row, not the resolver.)
    const drain = processBindingReconcileQueue({ limit: 50 });
    expect(drain.processed).toBeGreaterThanOrEqual(1);
    const after = readActiveBinding(orgId, artifactId);
    expect(after?.bindingClaimId).toBe(orgClaim.id);
    expect(after?.extension).toBe(pkgOrg);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  });

  it("AC-3: type change across claims archives + re-asserts atomically; undo/restore re-derives", () => {
    const orgId = nextId("org");
    const typeA = `@vendor/${nextId("a")}:thing`;
    const typeB = `@vendor/${nextId("b")}:thing`;
    const artifactId = nextId("obj");
    const pkgA = "@vendor/a-artifact";
    const pkgB = "@vendor/b-artifact";
    seedObject({ id: artifactId, type: typeA, orgId });
    const claimA = seedDedicatedClaim({ scope: `org:${orgId}`, type: typeA, pkg: pkgA });
    const claimB = seedDedicatedClaim({ scope: `org:${orgId}`, type: typeB, pkg: pkgB });

    reconcileArtifactBinding({ orgId, artifactId });
    expect(readActiveBinding(orgId, artifactId)?.bindingClaimId).toBe(claimA.id);

    // Type change A → B: reconcile archives A's binding, inserts B's (one tx).
    setObjectType(artifactId, typeB);
    const r1 = reconcileArtifactBinding({ orgId, artifactId });
    expect(r1.archived).toBe(1);
    expect(r1.inserted).toBe(1);
    expect(readActiveBinding(orgId, artifactId)?.bindingClaimId).toBe(claimB.id);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);

    // Undo/restore B → A: re-derives A's binding (a NEW row — append-only).
    setObjectType(artifactId, typeA);
    const r2 = reconcileArtifactBinding({ orgId, artifactId });
    expect(r2.archived).toBe(1);
    expect(r2.inserted).toBe(1);
    expect(readActiveBinding(orgId, artifactId)?.bindingClaimId).toBe(claimA.id);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
    // Two archived A-bindings + two archived B... at least the archived history exists.
    const archived = sql(
      `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND artifact_id=$2 AND assertion_basis='binding' AND eligibility='archived'`,
      [orgId, artifactId],
    );
    expect(Number(archived.rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  it("classic never displaces a binding: a same-extension classic assertion cannot archive the binding (codex #2 fix)", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("cnd")}:thing`;
    const artifactId = nextId("obj");
    const pkg = "@vendor/cnd-artifact";
    seedObject({ id: artifactId, type, orgId });
    seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg });
    reconcileArtifactBinding({ orgId, artifactId });
    expect(readActiveBinding(orgId, artifactId)?.extension).toBe(pkg);

    // Attempt a classic (agent) assertion for the SAME extension as the binding.
    // The archive statement excludes assertion_basis='binding', so the binding
    // is not archived; the insert then collides on sa_active_unique_idx and the
    // whole tx aborts — the binding SURVIVES either way (never displaced).
    const reQualify = (t: string) =>
      t.replace(/"[a-z_0-9]+"\.("semantic_assertion")/g, (_m, tbl) => `"${S()}".${tbl}`);
    const { queries } = buildAssertSemanticTypeQueries({ orgId, artifactId, extension: pkg, assertedBy: "agent" });
    expect(() =>
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        transaction: true,
        queries: [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [artifactId] },
          ...queries.map((qy) => ({ text: reQualify(qy.text), values: qy.values })),
        ],
      }),
    ).toThrow(/sa_active_unique_idx|duplicate key/);
    // Binding survived.
    expect(readActiveBinding(orgId, artifactId)?.extension).toBe(pkg);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  });

  it("same-extension classic supersede (cinatra#1493): a PRE-EXISTING live classic row from the winner extension is archived and the binding inserts in one tx — no sa_active_unique_idx throw", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("sup")}:thing`;
    const artifactId = nextId("obj");
    const pkg = "@vendor/sup-artifact";
    const otherPkg = "@vendor/bystander-artifact";
    seedObject({ id: artifactId, type, orgId });
    // A pre-claims classic identity row from the SOON-TO-BE winner extension —
    // the exact state a first claim activation (or an uninstall-replay's
    // replacement classic) leaves on disk. Plus a bystander classic from a
    // DIFFERENT extension that must survive untouched.
    const classicId = nextId("sa");
    sql(
      `INSERT INTO "${S()}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility)
       VALUES ($1,$2,$3,$4,'agent','eligible')`,
      [classicId, orgId, artifactId, pkg],
    );
    const bystanderId = nextId("sa");
    sql(
      `INSERT INTO "${S()}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility)
       VALUES ($1,$2,$3,$4,'agent','eligible')`,
      [bystanderId, orgId, artifactId, otherPkg],
    );
    seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg });

    // Without the supersede clause this THROWS duplicate-key on
    // sa_active_unique_idx and the reconcile-queue row would park 'failed'.
    const res = reconcileArtifactBinding({ orgId, artifactId });
    expect(res.inserted).toBe(1);
    expect(res.archived).toBe(1); // the winner's classic row — nothing else
    expect(readActiveBinding(orgId, artifactId)?.extension).toBe(pkg);

    // The winner's classic row is archived; the bystander classic is untouched.
    const rows = sql(
      `SELECT id, eligibility FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND artifact_id=$2 AND assertion_basis='classic'`,
      [orgId, artifactId],
    ).rows as Array<{ id: string; eligibility: string }>;
    expect(rows.find((r) => r.id === classicId)?.eligibility).toBe("archived");
    expect(rows.find((r) => r.id === bystanderId)?.eligibility).toBe("eligible");

    // Idempotent re-run: nothing further changes.
    const again = reconcileArtifactBinding({ orgId, artifactId });
    expect(again).toEqual({ archived: 0, inserted: 0, changed: false });

    // No-winner regression guard: retiring the claim archives the binding but
    // NEVER touches classic rows (the supersede clause is winner-scoped).
    const claims = readArtifactTypeClaimsForExtension(`org:${orgId}`, pkg);
    for (const c of claims) {
      beginArtifactTypeClaimRetirement({ claimId: c.id, actor: "system" });
      finalizeArtifactTypeClaimRetirement({ claimId: c.id, actor: "system" });
    }
    const after = reconcileArtifactBinding({ orgId, artifactId });
    expect(after.archived).toBe(1); // the binding only
    expect(readActiveBinding(orgId, artifactId)).toBeNull();
    const bystander = sql(
      `SELECT eligibility FROM "${S()}"."semantic_assertion" WHERE id = $1`,
      [bystanderId],
    ).rows[0] as { eligibility: string };
    expect(bystander.eligibility).toBe("eligible");
  });

  it("AC-4a: enforcement — an invalid payload for an activated type is rejected", () => {
    const type = "@vendor/enforce:thing";
    const validate = (d: unknown) => typeof (d as { title?: unknown })?.title === "string";
    // Activated (claimed) + registered validator + invalid payload ⇒ throw.
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: type, data: { title: 42 }, hasActiveClaim: true, validate }),
    ).toThrow(InvalidActivatedTypePayloadError);
    // Valid payload ⇒ ok.
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: type, data: { title: "ok" }, hasActiveClaim: true, validate }),
    ).not.toThrow();
    // No active claim ⇒ not gated.
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: type, data: { title: 42 }, hasActiveClaim: false, validate }),
    ).not.toThrow();
  });

  it("AC-4b: activation gate requires a registered schema and quarantines invalid legacy rows", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("g")}:thing`;
    const good = nextId("obj");
    const bad = nextId("obj");
    seedObject({ id: good, type, orgId, data: { title: "hi" } });
    seedObject({ id: bad, type, orgId, data: { title: 999 } });

    // No registered validator ⇒ claim not activatable.
    expect(() =>
      assertClaimActivatable({ scope: `org:${orgId}`, objectTypeId: type, validate: null }),
    ).toThrow(ClaimNotActivatableError);

    const validate = (d: unknown) => typeof (d as { title?: unknown })?.title === "string";
    const audit = assertClaimActivatable({ scope: `org:${orgId}`, objectTypeId: type, validate });
    expect(audit.audited).toBe(2);
    expect(audit.quarantined).toBe(1);
    expect(isObjectQuarantined(orgId, bad)).toBe(true);
    expect(isObjectQuarantined(orgId, good)).toBe(false);
  });

  it("AC-4c: a quarantined row is excluded from binding activation", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("q")}:thing`;
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId, data: { bad: true } });
    seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg: "@vendor/q-artifact" });
    quarantineObject({ orgId, objectId: artifactId, objectTypeId: type, reason: "test" });

    const res = reconcileArtifactBinding({ orgId, artifactId });
    expect(res.inserted).toBe(0);
    expect(activeBindingCount(orgId, artifactId)).toBe(0);

    // Un-quarantine ⇒ the binding is written.
    sql(`DELETE FROM "${S()}"."object_binding_quarantine" WHERE org_id=$1 AND object_id=$2`, [orgId, artifactId]);
    expect(reconcileArtifactBinding({ orgId, artifactId }).inserted).toBe(1);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  });

  it("AC-5: backfill is checkpoint-resumable and idempotent (re-run inserts zero)", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("bf")}:thing`;
    const scope = `org:${orgId}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `bfobj-${orgId}-${String(i).padStart(3, "0")}`;
      ids.push(id);
      seedObject({ id, type, orgId });
    }
    const claim = seedDedicatedClaim({ scope, type, pkg: "@vendor/bf-artifact" });

    // Resumable: process one batch of 2, then resume.
    const part1 = reconcileTypeBindings({ scope, objectTypeId: type, generation: claim.generation, batchSize: 2, maxBatches: 1 });
    expect(part1.processed).toBe(2);
    expect(part1.inserted).toBe(2);
    expect(part1.done).toBe(false);
    const part2 = reconcileTypeBindings({ scope, objectTypeId: type, generation: claim.generation, batchSize: 2 });
    expect(part2.done).toBe(true);
    expect(part2.inserted).toBe(3);
    // All 5 rows now carry a binding.
    for (const id of ids) expect(activeBindingCount(orgId, id)).toBe(1);
    const cp = sql(
      `SELECT processed_count, inserted_count, status FROM "${S()}"."artifact_binding_backfill_checkpoint"
       WHERE scope=$1 AND object_type_id=$2 AND generation=$3`,
      [scope, type, claim.generation],
    );
    expect(Number(cp.rows[0].processed_count)).toBe(5);
    expect(cp.rows[0].status).toBe("done");

    // Idempotent: a fresh full backfill re-verifies to ZERO new rows.
    const rerun = runBindingBackfill({ scope, objectTypeId: type, generation: claim.generation });
    expect(rerun.processed).toBe(5);
    expect(rerun.inserted).toBe(0);
    for (const id of ids) expect(activeBindingCount(orgId, id)).toBe(1);
  });
});

describe("cinatra#1429 — write-path composition (reconcileArtifactBindingForWrite, real DB)", () => {
  it("a write of a claimed-type row INSERTs the winner's binding (has_claim gate)", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const pkg = "@vendor/compose-a-artifact";
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    const claim = seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg });

    const res = reconcileArtifactBindingForWrite({ orgId, artifactId, type });
    expect(res.inserted).toBe(1);
    expect(res.changed).toBe(true);
    const b = readActiveBinding(orgId, artifactId);
    expect(b?.bindingClaimId).toBe(claim.id);
    // Idempotent on a second write of the same row (matching binding ⇒ no-op).
    const again = reconcileArtifactBindingForWrite({ orgId, artifactId, type });
    expect(again.inserted).toBe(0);
    expect(again.archived).toBe(0);
    expect(again.changed).toBe(false);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);
  });

  it("a substrate write (no claim, no binding) short-circuits to a no-op", () => {
    const orgId = nextId("org");
    const type = "@cinatra-ai/artifact:object"; // generic — never dedicated-claimed
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });

    const res = reconcileArtifactBindingForWrite({ orgId, artifactId, type });
    expect(res).toEqual({ archived: 0, inserted: 0, changed: false });
    expect(activeBindingCount(orgId, artifactId)).toBe(0);
  });

  it("a type change AWAY from a claimed type ARCHIVEs the stale binding (has_binding gate)", () => {
    const orgId = nextId("org");
    const claimedType = `@vendor/${nextId("pkg")}:thing`;
    const pkg = "@vendor/compose-b-artifact";
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type: claimedType, orgId });
    seedDedicatedClaim({ scope: `org:${orgId}`, type: claimedType, pkg });
    // First write: binding lands.
    expect(reconcileArtifactBindingForWrite({ orgId, artifactId, type: claimedType }).inserted).toBe(1);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);

    // Now the row's type changes to an UNCLAIMED type. The new type has no
    // dedicated claim (has_claim=false) but the artifact still carries the stale
    // binding (has_binding=true) → the guard opens the reconcile → archive.
    const plainType = "@cinatra-ai/artifact:object";
    setObjectType(artifactId, plainType);
    const res = reconcileArtifactBindingForWrite({ orgId, artifactId, type: plainType });
    expect(res.archived).toBe(1);
    expect(res.inserted).toBe(0);
    expect(res.changed).toBe(true);
    expect(activeBindingCount(orgId, artifactId)).toBe(0);
  });

  it("a null-org write short-circuits (no binding surface)", () => {
    const res = reconcileArtifactBindingForWrite({
      orgId: null,
      artifactId: nextId("obj"),
      type: "@vendor/whatever:thing",
    });
    expect(res).toEqual({ archived: 0, inserted: 0, changed: false });
  });
});

describe("cinatra#1493 — durable write-driven binding-reconcile queue (real DB)", () => {
  function enqueueWriteRow(orgId: string, artifactId: string, type: string): string {
    const id = nextId("rq");
    sql(
      `INSERT INTO "${S()}"."artifact_binding_reconcile_queue"
         (id, scope, object_type_id, object_id, org_id, kind, status)
       VALUES ($1, 'org:' || $2, $3, $4, $2, 'binding-reconcile-write', 'pending')`,
      [id, orgId, type, artifactId],
    );
    return id;
  }
  function queueStatus(id: string): string {
    return String(
      sql(`SELECT status FROM "${S()}"."artifact_binding_reconcile_queue" WHERE id=$1`, [id])
        .rows[0].status,
    );
  }

  it("drains a write-driven row: a create into a claimed type INSERTs the winner's binding; row → done", () => {
    const orgId = nextId("org");
    const type = `@vendor/${nextId("pkg")}:thing`;
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    const claim = seedDedicatedClaim({ scope: `org:${orgId}`, type, pkg: "@vendor/wq-a-artifact" });
    const rowId = enqueueWriteRow(orgId, artifactId, type);

    const res = processBindingReconcileQueue({ limit: 50 });
    expect(res.failed).toBe(0);
    expect(readActiveBinding(orgId, artifactId)?.bindingClaimId).toBe(claim.id);
    expect(queueStatus(rowId)).toBe("done");
  });

  it("durability (codex Q2): a type-change AWAY from a claimed type converges the STALE binding via the per-artifact write-driven row — a TYPE sweep of the claimed type could NEVER select this row", () => {
    const orgId = nextId("org");
    const claimedType = `@vendor/${nextId("pkg")}:thing`;
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type: claimedType, orgId });
    seedDedicatedClaim({ scope: `org:${orgId}`, type: claimedType, pkg: "@vendor/wq-b-artifact" });
    // Binding lands for the claimed type.
    expect(reconcileArtifactBindingForWrite({ orgId, artifactId, type: claimedType }).inserted).toBe(1);
    expect(activeBindingCount(orgId, artifactId)).toBe(1);

    // The row's type moves to an UNCLAIMED type. The claimed type's sweep no
    // longer selects this row (it is not that type anymore); only the durable
    // per-artifact write-driven record converges the stale binding.
    const plainType = "@cinatra-ai/artifact:object";
    setObjectType(artifactId, plainType);
    const rowId = enqueueWriteRow(orgId, artifactId, plainType);

    const res = processBindingReconcileQueue({ limit: 50 });
    expect(res.failed).toBe(0);
    expect(activeBindingCount(orgId, artifactId)).toBe(0); // stale binding archived
    expect(queueStatus(rowId)).toBe("done");
  });

  it("a write-driven row for a substrate object (no claim, no binding) is a safe no-op; row → done", () => {
    const orgId = nextId("org");
    const type = "@cinatra-ai/artifact:object";
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });
    const rowId = enqueueWriteRow(orgId, artifactId, type);

    const res = processBindingReconcileQueue({ limit: 50 });
    expect(res.failed).toBe(0);
    expect(activeBindingCount(orgId, artifactId)).toBe(0);
    expect(queueStatus(rowId)).toBe("done");
  });

  it("the shape CHECK rejects a write-driven row that omits object_id / org_id (each kind's required columns stay honest)", () => {
    let threw = false;
    try {
      sql(
        `INSERT INTO "${S()}"."artifact_binding_reconcile_queue"
           (id, scope, object_type_id, kind, status)
         VALUES ($1, 'org:x', '@v/p:t', 'binding-reconcile-write', 'pending')`,
        [nextId("rq")],
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

afterAll(() => {
  // best-effort: nothing to tear down (unique ids per test keep runs isolated).
});
