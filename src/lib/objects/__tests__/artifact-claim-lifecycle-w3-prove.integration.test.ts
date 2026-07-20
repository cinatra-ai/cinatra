// cinatra#1837 Wave-3 PROVE — LIVE-DB proof of the artifact-extension claim
// lifecycle (R3 restore reactivation, R4 interrupted-archival resumption, R2
// all-scopes retirement) against a real Postgres, on the PR-1842 head
// (lane/1454-artifact-claim-archival-wiring @ 9e514f7ad).
//
//   CINATRA_DB_INTEGRATION_TESTS=1 \
//   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/verify_1837_w3 \
//   SUPABASE_SCHEMA=cinatra \
//   E2E_EVIDENCE_FILE=/path/to/evidence.txt \
//     pnpm exec vitest run src/lib/objects/__tests__/artifact-claim-lifecycle-w3-prove.integration.test.ts
//
// The shipped unit tests are SQL-SHAPE proofs (the postgres runner is mocked).
// This wave drives the SAME shipped store functions against a real Postgres so
// the durable transitions are exercised end-to-end and each is captured as a
// QUERY PROOF (row states before/after every transition):
//   1. install -> governed rows -> ARCHIVE (claims retired, assertions
//      archived, canonical transition atomic: lineage == archived set).
//   2. RESTORE — the type is usable IMMEDIATELY (a write/read under it succeeds
//      right after restore, with NO boot cycle in between).
//   3. RE-ARCHIVE (a fresh operation, all restored+new rows archived).
//   4. INTERRUPTION DRILL — an archival killed mid-flight (a 'running' op with a
//      partial checkpoint) RESUMES to completion; the lineage stays
//      exactly-the-archived-set (no double-archive).
//   5. ALL-SCOPES primitive on seeded MULTI-ORG data — only the TARGET package's
//      rows, in EVERY org scope, are retired; the platform leg defers; a
//      co-resident OTHER package is untouched (nothing else).

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The full app bootstrap references Supabase-only tables absent on a plain
// verify Postgres; no-op it and build ONLY the leaves this slice needs (same
// pattern as artifact-claim-install-anchor.integration.test.ts).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { semanticAssertionSchemaQueries } from "@/lib/semantic-assertion-schema";
import { artifactClaimSchemaQueries } from "@/lib/artifact-claim-schema";
import { graphitiProjectionPolicySchemaQueries } from "@/lib/graphiti-projection-policy-schema";

import {
  activateArtifactExtensionClaims,
  retireArtifactExtensionClaims,
  retireArtifactExtensionClaimsAllScopes,
  replayArtifactExtensionReinstall,
  type LifecycleClaim,
  type ArtifactClaimLifecycleContext,
} from "@/lib/objects/artifact-claim-lifecycle";
import {
  readArtifactTypeClaimsForExtension,
  reserveArtifactTypeClaim,
  activateArtifactTypeClaim,
} from "@/lib/objects/artifact-claim-store";
import {
  beginArtifactUninstallOperation,
  buildArchiveArtifactAssertionsWithLineageQuery,
} from "@/lib/objects/artifact-uninstall-operations";
import { runInstallAnchorClaimActivation } from "@/lib/objects/artifact-claim-install-anchor";
import { buildGraphitiRefreshQueries } from "@/lib/artifacts/semantic-assertion-store";

const EVIDENCE = process.env.E2E_EVIDENCE_FILE;
function evidence(tag: string, value: unknown) {
  const line = `[${tag}] ${typeof value === "string" ? value : JSON.stringify(value)}`;
  // eslint-disable-next-line no-console
  console.log(line);
  if (EVIDENCE) appendFileSync(EVIDENCE, line + "\n");
}

const S = () => postgresSchema.replaceAll('"', '""');
let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

function exec(text: string) {
  runPostgresQueriesSync({ connectionString: getPostgresConnectionString(), queries: [{ text }] });
}
function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}
function rows(text: string, values: unknown[] = []): Array<Record<string, unknown>> {
  return (sql(text, values).rows ?? []) as Array<Record<string, unknown>>;
}

/** Seed an object row + a live CLASSIC eligible assertion under the extension —
 *  the governed material the archival walks and the restore replays. */
function seedGovernedRow(input: { orgId: string; extension: string; type?: string }): {
  artifactId: string;
  assertionId: string;
} {
  const artifactId = nextId("obj");
  const assertionId = nextId("sa");
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility)
     VALUES ($1,$2,$3,'{}'::jsonb,1,'pending','organization',$3,'organization')`,
    [artifactId, input.type ?? "@cinatra-ai/artifact:object", input.orgId],
  );
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility)
     VALUES ($1,$2,$3,$4,'user','eligible')`,
    [assertionId, input.orgId, artifactId, input.extension],
  );
  return { artifactId, assertionId };
}

function claimStates(scope: string, pkg: string) {
  return readArtifactTypeClaimsForExtension(scope, pkg)
    .map((c) => ({ type: c.objectTypeId, kind: c.claimKind, status: c.status }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
function liveClaimCount(scope: string, pkg: string): number {
  return readArtifactTypeClaimsForExtension(scope, pkg).filter((c) => c.status !== "retired").length;
}
function eligibleCount(orgId: string, pkg: string): number {
  return Number(
    rows(
      `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND extension=$2 AND eligibility='eligible'`,
      [orgId, pkg],
    )[0].n,
  );
}
function archivedCount(orgId: string, pkg: string): number {
  return Number(
    rows(
      `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND extension=$2 AND eligibility='archived'`,
      [orgId, pkg],
    )[0].n,
  );
}
function lineageCount(operationId: string): number {
  return Number(
    rows(
      `SELECT count(*)::int AS n FROM "${S()}"."artifact_uninstall_operation_assertions" WHERE operation_id=$1`,
      [operationId],
    )[0].n,
  );
}
function opStatus(operationId: string): string {
  const r = rows(
    `SELECT status FROM "${S()}"."artifact_uninstall_operations" WHERE id=$1`,
    [operationId],
  );
  return r.length ? String(r[0].status) : "<absent>";
}
/** The assertion ids the extension has in a given eligibility, sorted — for an
 *  independent exact-SET check (not a cardinality-only check). */
function assertionIds(orgOrNull: string | null, pkg: string, eligibility: string): string[] {
  const clause = orgOrNull == null ? "" : "AND org_id=$2";
  const values = orgOrNull == null ? [pkg] : [pkg, orgOrNull];
  return rows(
    `SELECT id FROM "${S()}"."semantic_assertion"
     WHERE extension=$1 ${clause} AND eligibility=${orgOrNull == null ? "$2" : "$3"}
     ORDER BY id`,
    orgOrNull == null ? [pkg, eligibility] : [...values, eligibility],
  ).map((r) => String(r.id)).sort();
}
/** The assertion ids the operation's lineage records, sorted. */
function lineageIds(operationId: string): string[] {
  return rows(
    `SELECT assertion_id FROM "${S()}"."artifact_uninstall_operation_assertions"
     WHERE operation_id=$1 ORDER BY assertion_id`,
    [operationId],
  ).map((r) => String(r.assertion_id)).sort();
}
/** A registered-validator resolver (the write-enforceability gate the real
 *  install/restore supplies): every declared type resolves to an object check. */
const resolveObjectValidator = (): ((data: unknown) => boolean) =>
  (data: unknown) => typeof data === "object" && data !== null;

beforeAll(() => {
  const s = S();
  exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  // Minimal objects table (the activation gate's legacy-row audit reads it) —
  // same pattern as artifact-claim-install-anchor.integration.test.ts, which
  // avoids the full store schema's public.user (Supabase-only) dependency.
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."objects" (
    id text PRIMARY KEY, type text NOT NULL, parent_id text, parent_type text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), created_by text, org_id text,
    source text, version integer NOT NULL DEFAULT 1,
    graphiti_sync_status text DEFAULT 'pending', graphiti_projection_error text,
    owner_level text, owner_id text, visibility text, project_id text,
    deleted_at timestamptz )`);
  // The graphiti projection outbox the floor-rebalance tail writes to (the
  // standalone drizzle-store DDL, no public.user dependency).
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."graphiti_projection_outbox" (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, object_id TEXT NOT NULL,
    object_version INTEGER NOT NULL, org_id TEXT, operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', payload_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ )`);
  for (const query of [
    ...semanticAssertionSchemaQueries(postgresSchema),
    ...artifactClaimSchemaQueries(postgresSchema),
    ...graphitiProjectionPolicySchemaQueries(postgresSchema),
  ]) {
    exec(query.text);
  }
  evidence("setup", { db: process.env.SUPABASE_DB_URL, schema: postgresSchema });
});

afterAll(() => {
  // Isolated per-run proof DB — left for post-mortem.
});

function freshFixture(orgId = nextId("org")) {
  const pkgLocal = nextId("pkg");
  const pkg = `@v/${pkgLocal}-artifact`;
  const claims: LifecycleClaim[] = [
    {
      type: `@v/${pkgLocal}:thing`,
      claim: "dedicated",
      dispositions: { projection: "raw", pinnable: false, snapshotPolicy: "none", sensitivity: "normal" },
    },
    { type: `@v/${pkgLocal}:note`, claim: "default" },
  ];
  const ctx = (over: Partial<ArtifactClaimLifecycleContext> = {}): ArtifactClaimLifecycleContext => ({
    scope: `org:${orgId}`,
    extensionPackage: pkg,
    extensionVersion: "1.0.0",
    actor: "system",
    ...over,
  });
  return { orgId, pkg, scope: `org:${orgId}`, claims, ctx };
}

describe("cinatra#1837 W3 — R3/R4/R2 claim lifecycle (real DB)", () => {
  it("S1: install -> governed rows -> ARCHIVE retires claims + archives rows (canonical transition atomic)", () => {
    const f = freshFixture();
    // INSTALL: activate the manifest claims.
    activateArtifactExtensionClaims(f.ctx(), f.claims);
    evidence("S1.install.claims", claimStates(f.scope, f.pkg));
    expect(liveClaimCount(f.scope, f.pkg)).toBe(2);

    // Governed rows written while the extension is live.
    seedGovernedRow({ orgId: f.orgId, extension: f.pkg });
    seedGovernedRow({ orgId: f.orgId, extension: f.pkg });
    evidence("S1.preArchive", {
      eligible: eligibleCount(f.orgId, f.pkg),
      archived: archivedCount(f.orgId, f.pkg),
      liveClaims: liveClaimCount(f.scope, f.pkg),
    });
    expect(eligibleCount(f.orgId, f.pkg)).toBe(2);

    // ARCHIVE (uninstall dispatch's fail-closed retirement).
    const res = retireArtifactExtensionClaims(f.ctx());
    evidence("S1.archive.result", {
      operationId: res.operationId,
      archivedAssertions: res.archivedAssertions,
      retiredClaims: res.retiredClaims.length,
      resumed: res.resumedOperationIds,
    });
    evidence("S1.postArchive.claims", claimStates(f.scope, f.pkg));
    evidence("S1.postArchive", {
      eligible: eligibleCount(f.orgId, f.pkg),
      archived: archivedCount(f.orgId, f.pkg),
      liveClaims: liveClaimCount(f.scope, f.pkg),
      opStatus: opStatus(res.operationId!),
      lineageRows: lineageCount(res.operationId!),
    });

    // Claims retired, governed rows archived.
    expect(liveClaimCount(f.scope, f.pkg)).toBe(0);
    expect(claimStates(f.scope, f.pkg).every((c) => c.status === "retired")).toBe(true);
    expect(eligibleCount(f.orgId, f.pkg)).toBe(0);
    expect(res.archivedAssertions).toBe(2);
    // CANONICAL TRANSITION EXACTLY-THE-ARCHIVED-SET: an INDEPENDENT set check —
    // the ids that flipped to 'archived' are byte-for-byte the ids the lineage
    // recorded (not merely equal cardinalities).
    const archivedSet = assertionIds(f.orgId, f.pkg, "archived");
    const lineageSet = lineageIds(res.operationId!);
    evidence("S1.exactSet", { archivedIds: archivedSet, lineageIds: lineageSet });
    expect(archivedSet.length).toBe(2);
    expect(lineageSet).toEqual(archivedSet);
    expect(opStatus(res.operationId!)).toBe("completed");
  });

  it("S1b: the archive step is ATOMIC — an injected failure in the archive tx rolls the transition back (nothing half-archived)", () => {
    const f = freshFixture();
    activateArtifactExtensionClaims(f.ctx(), f.claims);
    const seeded = seedGovernedRow({ orgId: f.orgId, extension: f.pkg });
    const op = beginArtifactUninstallOperation({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    // Run the REAL per-artifact archive CTE, then FORCE an error LATER in the
    // SAME transaction. If the archive UPDATE + lineage INSERT were not one
    // atomic unit, the row would be left 'archived' with no way back; the whole
    // tx must roll back instead.
    let threw = false;
    try {
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        transaction: true,
        queries: [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [seeded.artifactId] },
          buildArchiveArtifactAssertionsWithLineageQuery(postgresSchema, {
            operationId: op,
            orgId: f.orgId,
            artifactId: seeded.artifactId,
            extension: f.pkg,
          }),
          { text: `SELECT 1 / 0` }, // injected mid-tx failure
        ],
      });
    } catch {
      threw = true;
    }
    evidence("S1b.rollback", {
      threw,
      eligibleAfterRollback: eligibleCount(f.orgId, f.pkg),
      archivedAfterRollback: archivedCount(f.orgId, f.pkg),
      lineageAfterRollback: lineageCount(op),
    });
    expect(threw).toBe(true);
    // The transition rolled back: the assertion is STILL eligible, nothing
    // archived, no lineage — proof the archive + lineage commit all-or-nothing.
    expect(eligibleCount(f.orgId, f.pkg)).toBe(1);
    expect(archivedCount(f.orgId, f.pkg)).toBe(0);
    expect(lineageCount(op)).toBe(0);
  });

  it("S2: RESTORE reactivates claims + replays rows; the type is usable IMMEDIATELY (no boot)", () => {
    const f = freshFixture();
    activateArtifactExtensionClaims(f.ctx(), f.claims);
    const a1 = seedGovernedRow({ orgId: f.orgId, extension: f.pkg });
    seedGovernedRow({ orgId: f.orgId, extension: f.pkg });
    const archive = retireArtifactExtensionClaims(f.ctx());
    expect(eligibleCount(f.orgId, f.pkg)).toBe(0);
    expect(liveClaimCount(f.scope, f.pkg)).toBe(0);
    evidence("S2.archived", { op: archive.operationId, archived: archive.archivedAssertions });

    // RESTORE via the EXACT function the R3 reactivation hook invokes
    // (runInstallAnchorClaimActivation) — WITH the write-enforceability gate
    // (resolveTypeValidator), the same gate the live restore supplies. This
    // replays the owed op (re-inserts classic assertions for the archived set)
    // AND re-activates the claims THROUGH the gate — synchronously, no boot.
    const restore = runInstallAnchorClaimActivation({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.1",
      installId: nextId("inst"),
      claims: f.claims,
      resolveTypeValidator: resolveObjectValidator,
    });
    evidence("S2.restore.result", restore);
    evidence("S2.postRestore.claims", claimStates(f.scope, f.pkg));
    evidence("S2.postRestore", {
      eligible: eligibleCount(f.orgId, f.pkg),
      liveClaims: liveClaimCount(f.scope, f.pkg),
    });
    // The restore drove through the activation gate and replayed the archive op.
    expect(restore.outcome).toBe("activated");
    expect((restore as { replayedOperationIds: string[] }).replayedOperationIds).toContain(
      archive.operationId,
    );
    expect(liveClaimCount(f.scope, f.pkg)).toBe(2);
    expect(eligibleCount(f.orgId, f.pkg)).toBe(2);
    // The originally-archived row is eligible again (usable), under a fresh id.
    const replayed = rows(
      `SELECT eligibility FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND artifact_id=$2 AND extension=$3 AND eligibility='eligible'`,
      [f.orgId, a1.artifactId, f.pkg],
    );
    expect(replayed.length).toBe(1);

    // TYPE USABLE IMMEDIATELY — no boot cycle. The proof that the type is
    // write-enforce-ready the instant restore returns is the restore call
    // itself: runInstallAnchorClaimActivation RAN the activation gate
    // (assertClaimActivatable, with resolveTypeValidator) against the dedicated
    // claim and returned outcome:'activated' SYNCHRONOUSLY — the gate that the
    // live write path consults has already passed, in-call, with no process
    // restart. Corroborating that, the dedicated claim is ACTIVE and the store
    // accepts a fresh eligible assertion under the reactivated extension right
    // away. (NOTE: resolveObjectValidator is a stand-in for the live
    // resolveRegisteredTypeValidator, and this seeds via the assertion store,
    // not the full objects_save path — objects_save/payload enforcement is
    // covered by the shipped unit tests; here we prove the synchronous,
    // no-boot reactivation + gate pass + replay against the real DB.)
    const dedicated = readArtifactTypeClaimsForExtension(f.scope, f.pkg).find(
      (c) => c.objectTypeId === f.claims[0].type && c.status === "active",
    );
    const fresh = seedGovernedRow({ orgId: f.orgId, extension: f.pkg, type: f.claims[0].type });
    const readback = rows(
      `SELECT eligibility FROM "${S()}"."semantic_assertion" WHERE id=$1`,
      [fresh.assertionId],
    );
    evidence("S2.postRestore.freshWrite", {
      gatePassedInRestoreCall: restore.outcome === "activated",
      artifactId: fresh.artifactId,
      readbackEligibility: readback[0]?.eligibility,
      dedicatedClaimActive: Boolean(dedicated),
    });
    expect(restore.outcome).toBe("activated"); // the real gate passed, synchronously
    expect(dedicated).toBeDefined(); // active the instant restore returns (no boot)
    expect(readback[0]?.eligibility).toBe("eligible");
    expect(eligibleCount(f.orgId, f.pkg)).toBe(3); // 2 replayed + 1 fresh write
  });

  it("S3: RE-ARCHIVE the restored extension — a fresh operation archives every row", () => {
    const f = freshFixture();
    activateArtifactExtensionClaims(f.ctx(), f.claims);
    seedGovernedRow({ orgId: f.orgId, extension: f.pkg });
    const archive1 = retireArtifactExtensionClaims(f.ctx());
    const restore = replayArtifactExtensionReinstall(f.ctx({ extensionVersion: "1.0.1" }), f.claims);
    seedGovernedRow({ orgId: f.orgId, extension: f.pkg }); // extra write post-restore
    expect(eligibleCount(f.orgId, f.pkg)).toBe(2);

    const archive2 = retireArtifactExtensionClaims(f.ctx({ extensionVersion: "1.0.1" }));
    evidence("S3.reArchive.result", {
      firstOp: archive1.operationId,
      restoreReplayed: restore.replayedOperationId,
      secondOp: archive2.operationId,
      archivedAssertions: archive2.archivedAssertions,
      retiredClaims: archive2.retiredClaims.length,
    });
    evidence("S3.postReArchive", {
      eligible: eligibleCount(f.orgId, f.pkg),
      liveClaims: liveClaimCount(f.scope, f.pkg),
      secondOpStatus: opStatus(archive2.operationId!),
      secondOpLineage: lineageCount(archive2.operationId!),
    });
    // A DISTINCT fresh operation, all rows archived, claims retired again.
    expect(archive2.operationId).not.toBe(archive1.operationId);
    expect(archive2.archivedAssertions).toBe(2);
    expect(eligibleCount(f.orgId, f.pkg)).toBe(0);
    expect(liveClaimCount(f.scope, f.pkg)).toBe(0);
    expect(lineageCount(archive2.operationId!)).toBe(archive2.archivedAssertions);
  });

  it("S4: INTERRUPTION DRILL — an archival killed mid-flight RESUMES to completion, lineage exact", () => {
    const f = freshFixture();
    activateArtifactExtensionClaims(f.ctx(), f.claims);
    const seeded = [
      seedGovernedRow({ orgId: f.orgId, extension: f.pkg }),
      seedGovernedRow({ orgId: f.orgId, extension: f.pkg }),
      seedGovernedRow({ orgId: f.orgId, extension: f.pkg }),
    ];
    expect(eligibleCount(f.orgId, f.pkg)).toBe(3);

    // Reproduce the committed state a crash leaves when the runner (batchSize
    // granularity — a real multi-batch uninstall) has committed its FIRST batch
    // and the process is then killed before the next batch runs. We run the
    // runner's exact committed per-batch unit — the held-lock transaction
    // (advisory lock + archive CTE + floor-rebalance/refresh tail) — then its
    // per-batch checkpoint UPDATE, incrementing archived_count by the REAL
    // archived rowCount (not a hardcoded literal), exactly as
    // runArtifactUninstallArchival does. Nothing else runs (SIGKILL): the op is
    // left 'running' with the first batch archived + a checkpoint cursor and the
    // rest still eligible — the interrupted state a completed-only replay can
    // never reach.
    const op = beginArtifactUninstallOperation({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    const batchTx = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [
        { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [seeded[0].artifactId] },
        buildArchiveArtifactAssertionsWithLineageQuery(postgresSchema, {
          operationId: op,
          orgId: f.orgId,
          artifactId: seeded[0].artifactId,
          extension: f.pkg,
        }),
        ...buildGraphitiRefreshQueries(f.orgId, seeded[0].artifactId),
      ],
    });
    const batchArchived = batchTx[1].rowCount; // the archive CTE's real rowCount
    // The per-batch checkpoint the runner writes after each committed batch —
    // archived_count += the real batch delta, cursor at the last artifact.
    sql(
      `UPDATE "${S()}"."artifact_uninstall_operations"
       SET checkpoint = $2::jsonb, archived_count = archived_count + $3, updated_at = now()
       WHERE id = $1`,
      [op, JSON.stringify({ orgId: f.orgId, artifactId: seeded[0].artifactId }), batchArchived],
    );
    const checkpoint = rows(
      `SELECT checkpoint FROM "${S()}"."artifact_uninstall_operations" WHERE id=$1`,
      [op],
    )[0].checkpoint;
    evidence("S4.midCrash", {
      op,
      opStatus: opStatus(op),
      checkpoint,
      eligible: eligibleCount(f.orgId, f.pkg),
      archived: archivedCount(f.orgId, f.pkg),
      lineageSoFar: lineageCount(op),
    });
    expect(opStatus(op)).toBe("running"); // interrupted: never terminalized
    expect(eligibleCount(f.orgId, f.pkg)).toBe(2); // 1 archived, 2 owed
    expect(lineageCount(op)).toBe(1);

    // RESUME: the resume-aware fixpoint reaches the stranded 'running' op (which
    // completed-only replay never would) and drains it to completion.
    const resumed = retireArtifactExtensionClaims(f.ctx());
    evidence("S4.resume.result", {
      operationId: resumed.operationId,
      resumedOperationIds: resumed.resumedOperationIds,
      archivedThisRun: resumed.archivedAssertions,
      retiredClaims: resumed.retiredClaims.length,
    });
    evidence("S4.postResume", {
      opStatus: opStatus(op),
      eligible: eligibleCount(f.orgId, f.pkg),
      archived: archivedCount(f.orgId, f.pkg),
      lineageRows: lineageCount(op),
      liveClaims: liveClaimCount(f.scope, f.pkg),
    });
    // The SAME interrupted op was resumed (not a new one minted for the archival).
    expect(resumed.resumedOperationIds).toContain(op);
    expect(resumed.operationId).toBe(op);
    // Repaired: all 3 archived, op completed, claims retired.
    expect(opStatus(op)).toBe("completed");
    expect(eligibleCount(f.orgId, f.pkg)).toBe(0);
    expect(liveClaimCount(f.scope, f.pkg)).toBe(0);
    // Lineage is EXACTLY the archived set — no double-archive of artifact #1
    // (UNIQUE(operation_id, assertion_id) + ON CONFLICT DO NOTHING): an
    // independent id-set equality, not just a count.
    const archivedSet = assertionIds(f.orgId, f.pkg, "archived");
    const lineageSet = lineageIds(op);
    evidence("S4.exactSet", { archivedIds: archivedSet, lineageIds: lineageSet });
    expect(archivedSet.length).toBe(3);
    expect(lineageSet).toEqual(archivedSet);
    expect(new Set(seeded.map((s) => s.artifactId)).size).toBe(3);
  });

  it("S5: ALL-SCOPES primitive on multi-org data — only the target's rows, every scope, nothing else", () => {
    const orgA = nextId("orgA");
    const orgB = nextId("orgB");
    // TARGET package installed in orgA + orgB (org scopes) + a platform claim.
    const targetLocal = nextId("target");
    const target = `@v/${targetLocal}-artifact`;
    const targetClaim: LifecycleClaim = {
      type: `@v/${targetLocal}:thing`,
      claim: "dedicated",
      dispositions: { projection: "raw", pinnable: false, snapshotPolicy: "none", sensitivity: "normal" },
    };
    for (const org of [orgA, orgB]) {
      activateArtifactExtensionClaims(
        { scope: `org:${org}`, extensionPackage: target, extensionVersion: "1.0.0", actor: "system" },
        [targetClaim],
      );
      seedGovernedRow({ orgId: org, extension: target });
      seedGovernedRow({ orgId: org, extension: target });
    }
    // Scopes that ISOLATE each of the three discovery legs (claims ∪
    // eligible-assertions ∪ ops), so a single broken leg cannot pass vacuously:
    //   orgC — reachable ONLY via the uninstall-OPERATIONS leg (a stranded
    //          'running' op; NO live claim, NO eligible assertion).
    //   orgD — reachable ONLY via the eligible-ASSERTIONS leg (a governed
    //          eligible row; NO live claim, NO op in this org).
    //   orgE — reachable ONLY via the CLAIMS leg (a live claim; NO eligible
    //          assertion, NO op in this org).
    // (orgA/orgB are reachable via claims AND assertions.)
    const orgC = nextId("orgC");
    const strandedOp = beginArtifactUninstallOperation({
      scope: `org:${orgC}`,
      extensionPackage: target,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    const orgD = nextId("orgD");
    seedGovernedRow({ orgId: orgD, extension: target }); // eligible assertion, no claim in orgD
    const orgE = nextId("orgE");
    activateArtifactExtensionClaims(
      { scope: `org:${orgE}`, extensionPackage: target, extensionVersion: "1.0.0", actor: "system" },
      [targetClaim],
    ); // live claim, NO governed row in orgE

    // A platform (NULL-org) claim for the target — its all-scopes leg must DEFER (R1).
    const platClaimId = reserveArtifactTypeClaim({
      scope: "platform",
      objectTypeId: targetClaim.type,
      claimKind: "dedicated",
      extensionPackage: target,
      extensionVersion: "1.0.0",
      installId: null,
      dispositions: targetClaim.dispositions,
      actor: "system",
    });
    activateArtifactTypeClaim({ claimId: platClaimId, actor: "system" });

    // CONTROL package co-resident in orgA + orgB — must be UNTOUCHED (nothing else).
    const controlLocal = nextId("control");
    const control = `@v/${controlLocal}-artifact`;
    const controlClaim: LifecycleClaim = {
      type: `@v/${controlLocal}:thing`,
      claim: "dedicated",
      dispositions: { projection: "raw", pinnable: false, snapshotPolicy: "none", sensitivity: "normal" },
    };
    for (const org of [orgA, orgB]) {
      activateArtifactExtensionClaims(
        { scope: `org:${org}`, extensionPackage: control, extensionVersion: "1.0.0", actor: "system" },
        [controlClaim],
      );
      seedGovernedRow({ orgId: org, extension: control });
    }

    // EXACT before-images for the "nothing else" claim (ids + eligibility/status,
    // not just counts).
    const controlBefore = {
      orgA: assertionIds(orgA, control, "eligible"),
      orgB: assertionIds(orgB, control, "eligible"),
    };
    const platClaimBefore = rows(
      `SELECT id, status FROM "${S()}"."artifact_type_claims" WHERE id=$1`,
      [platClaimId],
    )[0];

    evidence("S5.preAllScopes", {
      target: {
        orgA: { live: liveClaimCount(`org:${orgA}`, target), eligible: eligibleCount(orgA, target) },
        orgB: { live: liveClaimCount(`org:${orgB}`, target), eligible: eligibleCount(orgB, target) },
        orgC_strandedOp: { op: strandedOp, status: opStatus(strandedOp), live: liveClaimCount(`org:${orgC}`, target) },
        platformClaim: platClaimBefore,
      },
      control: { orgA: controlBefore.orgA, orgB: controlBefore.orgB },
    });

    // ALL-SCOPES retirement of the TARGET — NO explicit canonicalScopes: the
    // primitive must DISCOVER every scope purely from the stores (claims,
    // eligible assertions, AND the stranded op in orgC).
    const res = retireArtifactExtensionClaimsAllScopes({
      extensionPackage: target,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    evidence("S5.allScopes.result", {
      retiredScopes: res.retiredScopes.sort(),
      deferredScopes: res.deferredScopes,
      totalRetiredClaims: res.totalRetiredClaims,
      totalArchivedAssertions: res.totalArchivedAssertions,
    });
    const controlAfter = {
      orgA: assertionIds(orgA, control, "eligible"),
      orgB: assertionIds(orgB, control, "eligible"),
    };
    const platClaimAfter = rows(
      `SELECT id, status FROM "${S()}"."artifact_type_claims" WHERE id=$1`,
      [platClaimId],
    )[0];
    evidence("S5.postAllScopes", {
      target: {
        orgA: { live: liveClaimCount(`org:${orgA}`, target), eligible: eligibleCount(orgA, target), archived: archivedCount(orgA, target) },
        orgB: { live: liveClaimCount(`org:${orgB}`, target), eligible: eligibleCount(orgB, target), archived: archivedCount(orgB, target) },
        orgC_strandedOpStatus: opStatus(strandedOp),
        platformClaim: platClaimAfter,
      },
      control: { orgA: controlAfter.orgA, orgB: controlAfter.orgB },
    });

    // EVERY discovered org scope of the target retired — each leg isolated:
    // orgA+orgB (claims+assertions), orgC (ops leg only), orgD (assertions leg
    // only), orgE (claims leg only); platform DEFERRED (R1).
    expect(res.retiredScopes.sort()).toEqual(
      [`org:${orgA}`, `org:${orgB}`, `org:${orgC}`, `org:${orgD}`, `org:${orgE}`].sort(),
    );
    expect(res.deferredScopes).toEqual(["platform"]);
    for (const org of [orgA, orgB]) {
      expect(liveClaimCount(`org:${org}`, target)).toBe(0);
      expect(eligibleCount(org, target)).toBe(0);
      expect(archivedCount(org, target)).toBe(2);
    }
    // orgD (assertions-leg-only) had its governed row archived, no claim to retire.
    expect(eligibleCount(orgD, target)).toBe(0);
    expect(archivedCount(orgD, target)).toBe(1);
    // orgE (claims-leg-only) had its live claim retired, no row to archive.
    expect(liveClaimCount(`org:${orgE}`, target)).toBe(0);
    expect(archivedCount(orgE, target)).toBe(0);
    // The orgC stranded op (ops-leg-only) was resumed to completion.
    expect(opStatus(strandedOp)).toBe("completed");
    // The platform target claim is UNTOUCHED — EXACT row identity (deferred leg
    // never ran).
    expect(liveClaimCount("platform", target)).toBe(1);
    expect(platClaimAfter).toEqual(platClaimBefore);
    // NOTHING ELSE: the co-resident control package's rows are byte-identical
    // before/after in both orgs (exact id sets, not counts).
    expect(controlAfter.orgA).toEqual(controlBefore.orgA);
    expect(controlAfter.orgB).toEqual(controlBefore.orgB);
    expect(controlBefore.orgA.length).toBe(1);
    expect(controlBefore.orgB.length).toBe(1);
    for (const org of [orgA, orgB]) {
      expect(liveClaimCount(`org:${org}`, control)).toBe(1);
      expect(archivedCount(org, control)).toBe(0);
    }
  });
});
