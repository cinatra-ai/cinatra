/**
 * cinatra#1430 — policy-aware content snapshots + GC-serialized retention
 * pinning + context plumbing, REAL-DB integration proof (no mocks on the
 * storage / DB path). Guarded by `describe.skipIf(!HAS_REAL_DB)` like the
 * sibling artifact integration suites: CI without a reachable Postgres emits
 * zero failures and zero noise.
 *
 * ISOLATION (the #926 blob-store suite's pattern): the schema is provisioned
 * FRESH per test file from the CANONICAL `buildCreateStoreSchemaQueries` DDL
 * (never the worktree's shared schema, never hand-rolled drift-prone DDL);
 * the blob root is a temp dir via `CINATRA_ARTIFACT_DATA_ROOT`. Because
 * `postgresSchema` is a module-load const in postgres-config, EVERY app
 * module is dynamically imported in `beforeAll` AFTER the env is set — a
 * static import would bind the SHARED schema and pollute the verify DB.
 *
 * Exercises every AC of #1430 end-to-end against real DDL + constraints:
 *   AC-1  keyed reuse + data-change mints a new snapshot + claimant change
 *         (fingerprint) mints a fresh snapshot for identical content.
 *   AC-2  finalization vs resource GC — a pinned resource is never deleted;
 *         removing the pin lets GC reclaim (the pin gate).
 *   AC-3  a claimed typed row resolves as a context candidate end-to-end
 *         (resolver → selection → serve) with the assertion triple intact.
 *   AC-4  redaction fail-closed — a seeded secret in row data BLOCKS the snapshot.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root vitest config aliases @/lib/database to a stub that lacks the named
// exports the artifact graph imports. Provide the metadata surface the
// creation/read graph touches PLUS the sync-leaf-backed connection/schema
// primitives (context-resolver / artifact-read / artifact-retention /
// resource-store / representation-store / run-context-selections-store import
// them from @/lib/database). The factory runs LAZILY on first dynamic import
// inside beforeAll — after the env is set — so postgres-config binds the
// isolated schema.
vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
// This slice needs only the tables provisioned below; short-circuit the app
// bootstrap (the #1490 binding-write-path suite's pattern).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_object_snapshot_1430";
const ORG = "org-snap-1430";
const EXT_A = "@cinatra-ai/campaigns-artifact";
const EXT_B = "@cinatra-ai/campaigns-alt-artifact";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

// Dynamically-bound app modules (assigned in beforeAll AFTER env set).
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let snapshotMod: typeof import("@/lib/artifacts/object-content-snapshot");
let finalizeMod: typeof import("@/lib/artifacts/context-selection-finalize");
let bindingMod: typeof import("@/lib/objects/binding-write-path");
let resolverMod: typeof import("@/lib/artifacts/context-resolver");
let readMod: typeof import("@/lib/artifacts/artifact-read");
let retentionMod: typeof import("@/lib/artifacts/artifact-retention");
let refsMod: typeof import("@/lib/artifacts/artifact-refs-store");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

function seedObject(id: string, type: string, data: unknown) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
    [id, type, ORG, JSON.stringify(data)],
  );
}

function setObjectData(id: string, data: unknown) {
  sql(
    `UPDATE "${S()}"."objects" SET data = $2::jsonb, version = version + 1 WHERE id = $1`,
    [id, JSON.stringify(data)],
  );
}

function softDeleteObject(id: string) {
  sql(`UPDATE "${S()}"."objects" SET deleted_at = now(), version = version + 1 WHERE id = $1`, [id]);
}

/** Directly seed an ACTIVE dedicated claim over `type` (org scope). Types are
 * PER-TEST so active-claim partial-unique indexes never collide across tests. */
function seedDedicatedClaim(input: { id: string; type: string; ext: string; dispositions: unknown }) {
  sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [input.id, `org:${ORG}`, input.type, input.ext, JSON.stringify(input.dispositions)],
  );
}

function retireClaim(id: string) {
  sql(`UPDATE "${S()}"."artifact_type_claims" SET status = 'retired' WHERE id = $1`, [id]);
}

function seedInstalledExtension(pkg: string) {
  // Canonical installed_extension DDL: owner_level/owner_id/source/version
  // are NOT NULL (version identity since cinatra#1040 S1).
  sql(
    `INSERT INTO "${S()}"."installed_extension"
       (id, package_name, owner_level, owner_id, organization_id, kind, status, source, version)
     VALUES ($1,$2,'organization',$3,$3,'artifact','active','{}'::jsonb,'1.0.0')
     ON CONFLICT DO NOTHING`,
    [nextId("inst"), pkg, ORG],
  );
}

function snapshotRowCount(objectId: string): number {
  const r = sql(
    `SELECT count(*)::int AS n FROM "${S()}"."object_content_snapshots" WHERE org_id=$1 AND object_id=$2`,
    [ORG, objectId],
  );
  return Number(r.rows[0].n);
}

function resourceExists(resourceId: string): boolean {
  const r = sql(`SELECT 1 FROM "${S()}"."resource" WHERE id=$1 AND org_id=$2`, [resourceId, ORG]);
  return (r.rows ?? []).length > 0;
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  // MUST precede every app-module import — postgresSchema is a module-load
  // const in postgres-config (see header).
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-1430-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  // Provision from the CANONICAL DDL builder (anti-drift: never hand-rolled).
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      // Same tolerance as the #926 suite: a handful of statements reference
      // seed/DO-block dependencies absent in a fresh empty schema.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  // Bind the app modules NOW (after env), so their load-time schema is the
  // isolated one.
  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  snapshotMod = await import("@/lib/artifacts/object-content-snapshot");
  finalizeMod = await import("@/lib/artifacts/context-selection-finalize");
  bindingMod = await import("@/lib/objects/binding-write-path");
  resolverMod = await import("@/lib/artifacts/context-resolver");
  readMod = await import("@/lib/artifacts/artifact-read");
  retentionMod = await import("@/lib/artifacts/artifact-retention");
  refsMod = await import("@/lib/artifacts/artifact-refs-store");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#1430 content snapshots + pinning + context plumbing (real DB + disk)", () => {
  it("AC-1: keyed reuse, data-change mints a new snapshot, claimant change mints a fresh snapshot for identical content", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-ac1";
    const objectId = nextId("obj-ac1");
    const claimA = nextId("claim-a");
    seedInstalledExtension(EXT_A);
    seedDedicatedClaim({ id: claimA, type: TYPE, ext: EXT_A, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
    seedObject(objectId, TYPE, { subject: "Launch", body: "hello" });
    // Give the row its binding via the REAL binding write path.
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    const bindingA = bindingMod.readActiveBinding(ORG, objectId);
    expect(bindingA).not.toBeNull();

    // First capture mints a snapshot.
    const s1 = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(s1).not.toBeNull();
    expect(s1!.reused).toBe(false);
    expect(s1!.effectiveBaseType).toBe(TYPE);
    expect(s1!.snapshotSchemaVersion).toBe(snapshotMod.SNAPSHOT_SCHEMA_VERSION);

    // Identical content re-pin REUSES (keyed) — same representation, no new row.
    const s1again = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(s1again!.reused).toBe(true);
    expect(s1again!.representationRevisionId).toBe(s1!.representationRevisionId);
    expect(snapshotRowCount(objectId)).toBe(1);

    // Data change → a NEW distinct snapshot.
    setObjectData(objectId, { subject: "Launch v2", body: "world" });
    const s2 = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(s2!.reused).toBe(false);
    expect(s2!.representationRevisionId).not.toBe(s1!.representationRevisionId);
    expect(s2!.contentDigest).not.toBe(s1!.contentDigest);
    expect(snapshotRowCount(objectId)).toBe(2);

    // Claimant change with IDENTICAL content → fresh snapshot (fingerprint).
    // Restore the exact v1 content, then swap the winning claim.
    setObjectData(objectId, { subject: "Launch", body: "hello" });
    const reuseV1 = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(reuseV1!.reused).toBe(true); // same content + same claimant ⇒ reuse s1.
    expect(reuseV1!.representationRevisionId).toBe(s1!.representationRevisionId);

    retireClaim(claimA);
    const claimB = nextId("claim-b");
    seedInstalledExtension(EXT_B);
    seedDedicatedClaim({ id: claimB, type: TYPE, ext: EXT_B, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content", sensitivity: "sensitive" } });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId }); // archives A binding, inserts B binding.
    const bindingB = bindingMod.readActiveBinding(ORG, objectId);
    expect(bindingB!.bindingClaimId).toBe(claimB);
    expect(bindingB!.id).not.toBe(bindingA!.id);

    const fpA = snapshotMod.computeClaimDispositionFingerprint({
      bindingClaimId: claimA,
      bindingGeneration: 1,
      extension: EXT_A,
      dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
    });
    const fpB = snapshotMod.computeClaimDispositionFingerprint({
      bindingClaimId: claimB,
      bindingGeneration: 1,
      extension: EXT_B,
      dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content", sensitivity: "sensitive" },
    });
    expect(fpA).not.toBe(fpB);

    const s3 = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    // Same bytes as v1, but a DIFFERENT claimant ⇒ never reuses A's snapshot.
    expect(s3!.reused).toBe(false);
    expect(s3!.contentDigest).toBe(s1!.contentDigest); // identical content …
    expect(s3!.claimDispositionFingerprint).not.toBe(s1!.claimDispositionFingerprint); // … different key.
    expect(s3!.representationRevisionId).not.toBe(s1!.representationRevisionId);
    expect(s3!.bindingAssertionId).toBe(bindingB!.id); // pin bound to the CURRENT claimant.
    expect(snapshotRowCount(objectId)).toBe(3);

    // FINALIZE CLAIMANT-ISOLATION (codex round-3): pinning the OLD claimant's
    // snapshot (s1, captured under A) with the NEW claimant's identity (B) is
    // REJECTED — the coherence gate requires the pinned representation to be
    // the snapshot captured under the CURRENT claimant fingerprint.
    const mkSel = (repId: string) => ({
      selection: {
        orgId: ORG,
        parentRunId: nextId("run-iso"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-iso",
        artifactId: objectId,
        representationRevisionId: repId,
        semanticAssertionId: bindingB!.id,
        extension: EXT_B,
        sourceScope: "organization" as const,
        selectedBy: "autonomous" as const,
        selectionMode: "autonomous" as const,
      },
      referrerKind: "agent_run" as const,
      referrerId: nextId("ref-iso"),
    });
    expect(() => finalizeMod.finalizeContextSelectionPin(mkSel(s1!.representationRevisionId))).toThrow(
      finalizeMod.SelectionCoherenceError,
    );
    // The CURRENT claimant's snapshot (s3) finalizes fine.
    const okFin = finalizeMod.finalizeContextSelectionPin(mkSel(s3!.representationRevisionId));
    expect(okFin.pinWritten).toBe(true);
  });

  it("AC-4: fail-closed redaction — a seeded secret in row data BLOCKS the snapshot", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-ac4";
    const objectId = nextId("obj-ac4");
    const claim = nextId("claim-ac4");
    seedInstalledExtension(EXT_A);
    seedDedicatedClaim({ id: claim, type: TYPE, ext: EXT_A, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
    // A recognizable secret shape (AWS access key id) embedded in the row data.
    seedObject(objectId, TYPE, { subject: "leak", note: "key AKIAIOSFODNN7EXAMPLE here" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });

    await expect(snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId })).rejects.toBeInstanceOf(
      snapshotMod.SnapshotRedactionError,
    );
    expect(snapshotRowCount(objectId)).toBe(0); // nothing was minted.

    // A sensitive KEY carrying a value is also blocked (fail-closed on key).
    const TYPE2 = "@cinatra-ai/campaigns:email-ac4b";
    const objectId2 = nextId("obj-ac4b");
    const claim2 = nextId("claim-ac4b");
    seedDedicatedClaim({ id: claim2, type: TYPE2, ext: EXT_A, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
    seedObject(objectId2, TYPE2, { subject: "cfg", api_key: "totally-secret-value" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId2 });
    await expect(snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId: objectId2 })).rejects.toBeInstanceOf(
      snapshotMod.SnapshotRedactionError,
    );
    expect(snapshotRowCount(objectId2)).toBe(0);
  });

  it("AC-2: a pinned resource is never GC'd; removing the pin lets GC reclaim it", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-ac2";
    const objectId = nextId("obj-ac2");
    const claim = nextId("claim-ac2");
    seedInstalledExtension(EXT_A);
    seedDedicatedClaim({ id: claim, type: TYPE, ext: EXT_A, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
    seedObject(objectId, TYPE, { subject: "pin-me", body: "retain" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    const binding = bindingMod.readActiveBinding(ORG, objectId);

    const snap = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(snap).not.toBeNull();
    const { representationRevisionId, resourceId } = snap!;

    // Finalize: coherence re-validation + selection row + REAL artifact_refs pin,
    // under the SAME resource-level advisory lock the GC takes.
    const referrerId = nextId("ref");
    const fin = finalizeMod.finalizeContextSelectionPin({
      selection: {
        orgId: ORG,
        parentRunId: nextId("run"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-a",
        artifactId: objectId,
        representationRevisionId,
        semanticAssertionId: binding!.id,
        extension: binding!.extension,
        sourceScope: "organization",
        selectedBy: "autonomous",
        selectionMode: "autonomous",
      },
      referrerKind: "agent_run",
      referrerId,
      digest: snap!.contentDigest,
      mime: "application/json",
      originKind: "snapshot",
    });
    expect(fin.selectionWritten).toBe(true);
    expect(fin.pinWritten).toBe(true);
    expect(refsMod.countArtifactRefs(ORG, objectId)).toBe(1);
    expect(refsMod.isRepresentationPinned(ORG, objectId, representationRevisionId)).toBe(true);

    // Make the resource a GC candidate: soft-delete the object (no live
    // representation parent) with retain_until elapsed (NULL). The PIN must
    // still protect it.
    softDeleteObject(objectId);
    const gc1 = await retentionMod.runResourceBlobGc({ orgId: ORG });
    expect(resourceExists(resourceId)).toBe(true); // pin gate held — never deleted.
    expect(gc1.reclaimed).toBe(0);

    // Remove the pin (the exact referrer we pinned with); now GC reclaims.
    refsMod.deleteArtifactRefsForReferrer({ orgId: ORG, referrerKind: "agent_run", referrerId });
    expect(refsMod.countArtifactRefs(ORG, objectId)).toBe(0);
    const gc2 = await retentionMod.runResourceBlobGc({ orgId: ORG });
    expect(gc2.reclaimed).toBeGreaterThanOrEqual(1);
    expect(resourceExists(resourceId)).toBe(false); // unpinned + elapsed ⇒ reclaimed.

    // Finalizing against the reclaimed resource REJECTS whole (no audit row
    // without a pin, no pin at dead bytes) — the GC-first ordering branch.
    expect(() =>
      finalizeMod.finalizeContextSelectionPin({
        selection: {
          orgId: ORG,
          parentRunId: nextId("run-dead"),
          parentPackageName: "@cinatra-ai/agent",
          slotId: "slot-a",
          artifactId: objectId,
          representationRevisionId,
          semanticAssertionId: binding!.id,
          extension: binding!.extension,
          sourceScope: "organization",
          selectedBy: "autonomous",
          selectionMode: "autonomous",
        },
        referrerKind: "agent_run",
        referrerId: nextId("ref-dead"),
      }),
    ).toThrow();

    // REMINT after GC: restore the row (same content + same claimant) — the
    // dead keying row must not block a fresh snapshot, and reuse must never
    // return the reclaimed resource (codex finding).
    sql(`UPDATE "${S()}"."objects" SET deleted_at = NULL, version = version + 1 WHERE id = $1`, [objectId]);
    const reminted = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(reminted).not.toBeNull();
    expect(reminted!.reused).toBe(false); // dead key never reused …
    expect(reminted!.resourceId).not.toBe(resourceId); // … a NEW resource was minted.
    expect(resourceExists(reminted!.resourceId)).toBe(true);
  });

  it("AC-3: a claimed typed row resolves as a context candidate end-to-end (resolver → selection → serve), triple intact", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-ac3";
    // Dedicated extension package for THIS test so the accepted-extensions
    // filter matches only its own object (no ordering coupling to siblings).
    const EXT_AC3 = "@cinatra-ai/campaigns-ac3-artifact";
    const objectId = nextId("obj-ac3");
    const claim = nextId("claim-ac3");
    seedInstalledExtension(EXT_AC3);
    seedDedicatedClaim({ id: claim, type: TYPE, ext: EXT_AC3, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
    seedObject(objectId, TYPE, { subject: "resolve-me", body: "candidate" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    const binding = bindingMod.readActiveBinding(ORG, objectId);

    // CAPTURE AT RESOLUTION TIME through the PRODUCTION composition: the
    // slot-scoped capture mints the snapshot and returns the pin the resolver
    // must use for claimed rows.
    const actor = {
      principalType: "HumanUser",
      principalId: "user-ac3",
      organizationId: ORG,
      authSource: "agent",
      projectIds: [],
    } as never;
    const slot = {
      slotId: "slot-ac3",
      acceptedArtifactExtensions: [EXT_AC3],
      selectionMode: "autonomous" as const,
      resolutionMode: "accumulate" as const,
    };
    const installedExtensions = [{ extension: EXT_AC3, satisfies: [] as string[] }];
    const cap = await snapshotMod.captureSnapshotsForContextSlot({
      actor,
      slot,
      installedExtensions,
    });
    expect(cap.captured).toBe(1);
    expect(cap.pins.length).toBe(1);
    expect(cap.pins[0].objectId).toBe(objectId);
    const snap = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(snap!.reused).toBe(true); // idempotent: the composition already minted it.
    expect(snap!.representationRevisionId).toBe(cap.pins[0].representationRevisionId);

    // A SECOND slot-scoped capture keyed-REUSES via the batched query (the
    // steady-state path) — same pin, no new snapshot.
    const cap2 = await snapshotMod.captureSnapshotsForContextSlot({
      actor,
      slot,
      installedExtensions,
    });
    expect(cap2.captured).toBe(0);
    expect(cap2.reused).toBe(1);
    expect(cap2.pins[0].representationRevisionId).toBe(cap.pins[0].representationRevisionId);

    // RESOLVER: the claimed typed row appears as a context candidate through
    // its PINNED snapshot representation (never "latest revision").
    const refs = resolverMod.resolveContextSlot({
      actor,
      slot,
      installedExtensions,
      snapshotPins: cap.pins,
    });
    expect(refs.length).toBe(1);
    const ref = refs[0];
    expect(ref.artifactId).toBe(objectId);
    expect(ref.representationRevisionId).toBe(snap!.representationRevisionId);
    expect(ref.semanticAssertionId).toBe(binding!.id);
    expect(ref.extension).toBe(EXT_AC3);

    // WITHOUT pins the claimed row is fail-closed EXCLUDED (a claimed row is
    // never resolvable through an unpinned/latest representation).
    const refsNoPins = resolverMod.resolveContextSlot({
      actor,
      slot,
      installedExtensions,
    });
    expect(refsNoPins.length).toBe(0);

    // SELECTION: finalize the resolved triple.
    const referrerId = nextId("ref-ac3");
    const fin = finalizeMod.finalizeContextSelectionPin({
      selection: {
        orgId: ORG,
        parentRunId: nextId("run-ac3"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-ac3",
        artifactId: ref.artifactId,
        representationRevisionId: ref.representationRevisionId,
        semanticAssertionId: ref.semanticAssertionId,
        extension: ref.extension,
        sourceScope: ref.sourceScope,
        selectedBy: "autonomous",
        selectionMode: "autonomous",
      },
      referrerKind: "agent_run",
      referrerId,
      digest: snap!.contentDigest,
      mime: "application/json",
      originKind: "snapshot",
    });
    expect(fin.selectionWritten).toBe(true);

    // The persisted selection row carries the EXACT triple (replay-safe).
    const selRow = sql(
      `SELECT artifact_id, representation_revision_id, semantic_assertion_id, extension
       FROM "${S()}"."run_context_selections" WHERE id = $1`,
      [fin.selectionId],
    ).rows[0] as Record<string, string>;
    expect(selRow.artifact_id).toBe(objectId);
    expect(selRow.representation_revision_id).toBe(snap!.representationRevisionId);
    expect(selRow.semantic_assertion_id).toBe(binding!.id);
    expect(selRow.extension).toBe(EXT_AC3);

    // SERVE: the claimed row's snapshot representation resolves through the
    // (now claim-aware) serve path.
    const serve = readMod.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: objectId,
      representationRevisionId: snap!.representationRevisionId,
    });
    expect(serve).not.toBeNull();
    expect(serve!.storageKey).toBeTruthy();
    expect(serve!.sizeBytes).toBe(snap!.sizeBytes);
  });

  it("policy: a non-pinnable / non-content claim never snapshots (capture refuses; composition excludes)", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-pol";
    const EXT_POL = "@cinatra-ai/campaigns-pol-artifact";
    const objectId = nextId("obj-pol");
    const claim = nextId("claim-pol");
    seedInstalledExtension(EXT_POL);
    // pinnable defaults false; snapshotPolicy defaults 'none' -- fail-closed.
    seedDedicatedClaim({ id: claim, type: TYPE, ext: EXT_POL, dispositions: { projection: "artifact-safe" } });
    seedObject(objectId, TYPE, { subject: "policy", body: "no-pin" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });

    await expect(snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId })).rejects.toBeInstanceOf(
      snapshotMod.SnapshotPolicyError,
    );
    expect(snapshotRowCount(objectId)).toBe(0);

    // The slot-scoped composition's SQL filter excludes the row entirely.
    const actor = {
      principalType: "HumanUser",
      principalId: "user-pol",
      organizationId: ORG,
      authSource: "agent",
      projectIds: [],
    } as never;
    const cap = await snapshotMod.captureSnapshotsForContextSlot({
      actor,
      slot: {
        slotId: "slot-pol",
        acceptedArtifactExtensions: [EXT_POL],
        selectionMode: "autonomous",
        resolutionMode: "accumulate",
      },
      installedExtensions: [{ extension: EXT_POL, satisfies: [] }],
    });
    expect(cap.attempted).toBe(0);
    expect(cap.pins.length).toBe(0);
  });

  it("redaction: a DOUBLE-JSON-ENCODED secret still blocks the snapshot (nested-string decode)", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-djs";
    const EXT_DJS = "@cinatra-ai/campaigns-djs-artifact";
    const objectId = nextId("obj-djs");
    const claim = nextId("claim-djs");
    seedInstalledExtension(EXT_DJS);
    seedDedicatedClaim({ id: claim, type: TYPE, ext: EXT_DJS, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
    // JSON.stringify(JSON.stringify({api_key})) -- a quote-leading string whose
    // decode chain hides the sensitive key two encodings deep.
    const smuggled = JSON.stringify(JSON.stringify({ api_key: "totally-secret-value" }));
    seedObject(objectId, TYPE, { subject: "cfg", payload: smuggled });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    await expect(snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId })).rejects.toBeInstanceOf(
      snapshotMod.SnapshotRedactionError,
    );
    expect(snapshotRowCount(objectId)).toBe(0);
  });

  it("atomic batch finalize: one incoherent ref aborts the WHOLE selection (no partial audit/pins)", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-bat";
    const EXT_BAT = "@cinatra-ai/campaigns-bat-artifact";
    seedInstalledExtension(EXT_BAT);
    const mk = async (suffix: string) => {
      const objectId = nextId(`obj-bat-${suffix}`);
      const claim = nextId(`claim-bat-${suffix}`);
      seedDedicatedClaim({ id: claim, type: `${TYPE}-${suffix}`, ext: EXT_BAT, dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" } });
      seedObject(objectId, `${TYPE}-${suffix}`, { subject: suffix });
      bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
      const binding = bindingMod.readActiveBinding(ORG, objectId);
      const snap = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
      return { objectId, binding: binding!, snap: snap! };
    };
    const a = await mk("a");
    const b = await mk("b");
    const parentRunId = nextId("run-bat");
    const referrerId = nextId("ref-bat");
    const selFor = (x: Awaited<ReturnType<typeof mk>>) => ({
      selection: {
        orgId: ORG,
        parentRunId,
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-bat",
        artifactId: x.objectId,
        representationRevisionId: x.snap.representationRevisionId,
        semanticAssertionId: x.binding.id,
        extension: x.binding.extension,
        sourceScope: "organization" as const,
        selectedBy: "autonomous" as const,
        selectionMode: "autonomous" as const,
      },
      referrerKind: "agent_run" as const,
      referrerId,
    });

    // Make ref B incoherent AFTER its snapshot exists (tombstone the object).
    softDeleteObject(b.objectId);

    expect(() =>
      finalizeMod.finalizeContextSelectionPinsAtomic([selFor(a), selFor(b)]),
    ).toThrow(finalizeMod.SelectionCoherenceError);

    // ALL-OR-NOTHING: ref A's audit row and pin must NOT have been committed.
    const selCount = sql(
      `SELECT count(*)::int AS n FROM "${S()}"."run_context_selections" WHERE org_id=$1 AND parent_run_id=$2`,
      [ORG, parentRunId],
    ).rows[0] as { n: number };
    expect(Number(selCount.n)).toBe(0);
    expect(refsMod.countArtifactRefs(ORG, a.objectId)).toBe(0);
    expect(refsMod.countArtifactRefs(ORG, b.objectId)).toBe(0);

    // The SAME batch with only the coherent ref commits (pin metadata is
    // DERIVED from the backing resource -- digest/mime/originKind omitted).
    const ok = finalizeMod.finalizeContextSelectionPinsAtomic([selFor(a)]);
    expect(ok[0].selectionWritten).toBe(true);
    expect(ok[0].pinWritten).toBe(true);
    expect(refsMod.countArtifactRefs(ORG, a.objectId)).toBe(1);
  });
});
