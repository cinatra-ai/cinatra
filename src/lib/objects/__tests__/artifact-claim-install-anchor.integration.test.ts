// Real-DB integration proof for the install-anchor claim-activation hook
// (cinatra#1493, epic #1424). Runs against a live Postgres (SUPABASE_DB_URL /
// SUPABASE_SCHEMA) — excluded from the fast `test:root` suite (root vitest
// excludes **/*.integration.test.ts). Exercises the hook against the REAL
// claim-registry DDL (partial-unique one-live-claimant indexes) — the
// self-conflict the idempotency exists to prevent is enforced by the actual
// constraints here, not a mock:
//   1. first install activates the manifest claims;
//   2. a re-fire (dispatcher retry) is a NO-OP — same claim ids, no new rows;
//   3. a rollback-to-prior-version re-fire is a NO-OP for unchanged claims;
//   4. a claim-set CHANGE routes through retire -> replay (new generation of
//      rows, stale set retired) — never a raw second activate;
//   5. a DEDICATED conflict with another extension NEVER throws at the anchor
//      (outcome 'failed', conflict:true) and leaves no partial winner set;
//   6. the activation gate fails CLOSED: a dedicated claim with no registered
//      validator does not activate (outcome 'failed'), and the install
//      pipeline is not failed by it;
//   7. reinstall-after-uninstall replays the owed uninstall operation.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The full app bootstrap references Supabase-only tables (public.user) absent
// on a plain verify Postgres; no-op it and build ONLY the leaves this slice
// needs (same pattern as binding-write-path.integration.test.ts).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { semanticAssertionSchemaQueries } from "@/lib/semantic-assertion-schema";
import { artifactClaimSchemaQueries } from "@/lib/artifact-claim-schema";

import { retireArtifactExtensionClaims } from "@/lib/objects/artifact-claim-lifecycle";
import {
  readArtifactTypeClaimsForExtension,
  reserveArtifactTypeClaim,
  activateArtifactTypeClaim,
} from "@/lib/objects/artifact-claim-store";
import {
  beginArtifactUninstallOperation,
  runArtifactUninstallArchival,
} from "@/lib/objects/artifact-uninstall-operations";
import { readActiveBinding } from "@/lib/objects/binding-write-path";
import { processBindingReconcileQueue } from "@/lib/objects/binding-reconcile-sweep";
import {
  runInstallAnchorClaimActivation,
  type LifecycleClaim,
} from "@/lib/objects/artifact-claim-install-anchor";

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

/** Seed an object row + a live CLASSIC semantic assertion of the extension —
 * the material the uninstall archival walks and the replay must restore. */
function seedClassicAssertion(input: { orgId: string; extension: string }): {
  artifactId: string;
  assertionId: string;
} {
  const artifactId = nextId("obj");
  const assertionId = nextId("sa");
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility)
     VALUES ($1,'@cinatra-ai/artifact:object',$2,'{}'::jsonb,1,'pending','organization',$2,'organization')`,
    [artifactId, input.orgId],
  );
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility)
     VALUES ($1,$2,$3,$4,'user','eligible')`,
    [assertionId, input.orgId, artifactId, input.extension],
  );
  return { artifactId, assertionId };
}

/** Fully drain the reconcile queue (the shared schema may carry rows from
 * OTHER tests/runs — a single limited pass can miss this test's rows). */
function drainReconcileQueue(): number {
  let processed = 0;
  for (let i = 0; i < 100; i++) {
    const pass = processBindingReconcileQueue({ limit: 100 });
    processed += pass.processed;
    if (pass.processed === 0) break;
  }
  return processed;
}

function eligibleAssertionCount(orgId: string, artifactId: string, extension: string): number {
  const r = sql(
    `SELECT count(*)::int AS n FROM "${S()}"."semantic_assertion"
     WHERE org_id=$1 AND artifact_id=$2 AND extension=$3 AND eligibility='eligible'`,
    [orgId, artifactId, extension],
  );
  return Number(r.rows[0].n);
}

beforeAll(() => {
  const s = S();
  exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  // Minimal objects table (the activation gate's legacy-row audit reads it).
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."objects" (
    id text PRIMARY KEY, type text NOT NULL, parent_id text, parent_type text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), created_by text, org_id text,
    source text, version integer NOT NULL DEFAULT 1,
    graphiti_sync_status text DEFAULT 'pending', graphiti_projection_error text,
    owner_level text, owner_id text, visibility text, project_id text,
    deleted_at timestamptz )`);
  // The merged claim-system leaves: claim registry + events + reconcile queue +
  // uninstall-operation lineage + quarantine/backfill support, and the
  // semantic_assertion table the uninstall archival walks.
  for (const query of [
    ...semanticAssertionSchemaQueries(postgresSchema),
    ...artifactClaimSchemaQueries(postgresSchema),
  ]) {
    exec(query.text);
  }
});

afterAll(() => {
  // The schema is an isolated per-run scratch schema; leave it for post-mortem.
});

/** A fresh org scope + package + 2-claim manifest per test. */
function freshFixture() {
  const orgId = nextId("org");
  const pkgLocal = nextId("pkg");
  const pkg = `@v/${pkgLocal}-artifact`;
  const claims: LifecycleClaim[] = [
    {
      type: `@v/${pkgLocal}:thing`,
      claim: "dedicated",
      dispositions: {
        projection: "raw",
        pinnable: false,
        snapshotPolicy: "none",
        sensitivity: "normal",
      },
    },
    { type: `@v/${pkgLocal}:note`, claim: "default" },
  ];
  return {
    scope: `org:${orgId}` as const,
    orgId,
    pkg,
    claims,
    input: (over: Partial<Parameters<typeof runInstallAnchorClaimActivation>[0]> = {}) => ({
      scope: `org:${orgId}`,
      extensionPackage: pkg,
      extensionVersion: "1.0.0",
      installId: nextId("inst"),
      claims,
      resolveTypeValidator: () => (data: unknown) =>
        typeof data === "object" && data !== null,
      ...over,
    }),
  };
}

function liveClaims(scope: string, pkg: string) {
  return readArtifactTypeClaimsForExtension(scope, pkg).filter((c) => c.status !== "retired");
}

describe("cinatra#1493 — install-anchor claim activation (real DB)", () => {
  it("AC-1: first install activates the manifest claims (dedicated active + default active)", () => {
    const f = freshFixture();
    const res = runInstallAnchorClaimActivation(f.input());
    expect(res).toMatchObject({ outcome: "activated", activatedClaims: 2, replayedOperationIds: [] });
    const live = liveClaims(f.scope, f.pkg);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((c) => c.status))).toEqual(new Set(["active"]));
    expect(new Set(live.map((c) => `${c.claimKind} ${c.objectTypeId}`))).toEqual(
      new Set([`dedicated ${f.claims[0].type}`, `default ${f.claims[1].type}`]),
    );
  });

  it("AC-2: a re-fire (dispatcher retry) is a NO-OP — same rows, no self-conflict", () => {
    const f = freshFixture();
    expect(runInstallAnchorClaimActivation(f.input()).outcome).toBe("activated");
    const before = liveClaims(f.scope, f.pkg).map((c) => c.id).sort();

    const again = runInstallAnchorClaimActivation(f.input({ installId: nextId("inst") }));
    expect(again).toEqual({
      outcome: "noop",
      reason: "live-claims-match",
      liveClaims: 2,
      replayedOperationIds: [],
    });

    const after = liveClaims(f.scope, f.pkg).map((c) => c.id).sort();
    expect(after).toEqual(before);
    // No extra rows of ANY status appeared (reserve never ran again).
    expect(readArtifactTypeClaimsForExtension(f.scope, f.pkg)).toHaveLength(2);
  });

  it("AC-3: a rollback-to-prior-version re-fire is a NO-OP for unchanged claims", () => {
    const f = freshFixture();
    expect(
      runInstallAnchorClaimActivation(f.input({ extensionVersion: "2.0.0" })).outcome,
    ).toBe("activated");
    const before = liveClaims(f.scope, f.pkg).map((c) => c.id).sort();

    // cinatra#793 compensation re-fires the pipeline for the CAPTURED PRIOR
    // version — same claim set, different version string.
    const rollbackRefire = runInstallAnchorClaimActivation(
      f.input({ extensionVersion: "1.0.0", installId: nextId("inst") }),
    );
    expect(rollbackRefire).toEqual({
      outcome: "noop",
      reason: "live-claims-match",
      liveClaims: 2,
      replayedOperationIds: [],
    });
    expect(liveClaims(f.scope, f.pkg).map((c) => c.id).sort()).toEqual(before);
  });

  it("AC-4: a claim-set CHANGE routes through retire -> replay — stale set retired, current set active", () => {
    const f = freshFixture();
    expect(runInstallAnchorClaimActivation(f.input()).outcome).toBe("activated");
    const oldIds = new Set(liveClaims(f.scope, f.pkg).map((c) => c.id));

    // Version 2 keeps the dedicated claim, drops the default, adds a new type.
    const changed: LifecycleClaim[] = [
      f.claims[0],
      { type: `${f.claims[1].type}-x`, claim: "default" },
    ];
    const res = runInstallAnchorClaimActivation(
      f.input({ claims: changed, extensionVersion: "2.0.0" }),
    );
    expect(res).toMatchObject({ outcome: "rewired", retiredClaims: 2, activatedClaims: 2 });

    const live = liveClaims(f.scope, f.pkg);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((c) => `${c.claimKind} ${c.objectTypeId}`))).toEqual(
      new Set([`dedicated ${changed[0].type}`, `default ${changed[1].type}`]),
    );
    // A NEW row generation — never the old rows re-used, never a raw second
    // activate on top of them.
    for (const c of live) expect(oldIds.has(c.id)).toBe(false);
    // The stale rows are 'retired', still present as history.
    const all = readArtifactTypeClaimsForExtension(f.scope, f.pkg);
    expect(all.filter((c) => c.status === "retired")).toHaveLength(2);
  });

  it("AC-5: a DEDICATED conflict with ANOTHER extension never throws — 'failed' outcome, no partial winner set", () => {
    const f = freshFixture();
    // Another extension already holds the dedicated claim on the SAME type.
    const holder = `@other/${nextId("holder")}-artifact`;
    const holderClaim = reserveArtifactTypeClaim({
      scope: f.scope,
      objectTypeId: f.claims[0].type,
      claimKind: "dedicated",
      extensionPackage: holder,
      extensionVersion: "1.0.0",
      installId: null,
      actor: "system",
    });
    activateArtifactTypeClaim({ claimId: holderClaim, actor: "system" });

    // Manifest order: default first, dedicated second — so the conflict fires
    // AFTER one claim already activated, proving the partial set is rolled back.
    const res = runInstallAnchorClaimActivation(
      f.input({ claims: [f.claims[1], f.claims[0]] }),
    );
    expect(res).toMatchObject({ outcome: "failed", conflict: true });
    // No live claims for the loser — the lifecycle retired its partial set.
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(0);
    // The holder's claim is untouched.
    expect(liveClaims(f.scope, holder)).toHaveLength(1);
  });

  it("AC-6: activation gate fails CLOSED — a dedicated claim with no registered validator does not activate", () => {
    const f = freshFixture();
    const res = runInstallAnchorClaimActivation(
      f.input({ resolveTypeValidator: () => null }),
    );
    expect(res).toMatchObject({ outcome: "failed", conflict: false });
    expect((res as { reason: string }).reason).toMatch(/cannot activate/);
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(0);
  });

  it("AC-7: reinstall after uninstall replays the owed uninstall operation, then activates", () => {
    const f = freshFixture();
    expect(runInstallAnchorClaimActivation(f.input()).outcome).toBe("activated");

    // Live uninstall dispatch retires the claims (opens a replayable operation).
    const retired = retireArtifactExtensionClaims({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    expect(retired.retiredClaims).toHaveLength(2);
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(0);

    const reinstall = runInstallAnchorClaimActivation(f.input({ installId: nextId("inst") }));
    expect(reinstall).toMatchObject({
      outcome: "activated",
      activatedClaims: 2,
      replayedOperationIds: [retired.operationId],
    });
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(2);
  });

  it("AC-8: a reinstall whose manifest DROPPED all claims still replays the owed operation — archived classic assertions restored", () => {
    const f = freshFixture();
    expect(runInstallAnchorClaimActivation(f.input()).outcome).toBe("activated");
    const seeded = seedClassicAssertion({ orgId: f.orgId, extension: f.pkg });
    expect(eligibleAssertionCount(f.orgId, seeded.artifactId, f.pkg)).toBe(1);

    // Uninstall archives the extension's eligible assertion + retires claims.
    const retired = retireArtifactExtensionClaims({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    expect(retired.archivedAssertions).toBe(1);
    expect(eligibleAssertionCount(f.orgId, seeded.artifactId, f.pkg)).toBe(0);

    // The reinstall's NEW manifest has ZERO objectTypes claims — the owed
    // replay must STILL run (codex High finding: a claims-less reinstall must
    // not leave the archived classic assertions permanently ineligible).
    const reinstall = runInstallAnchorClaimActivation(
      f.input({ claims: [], installId: nextId("inst"), extensionVersion: "2.0.0" }),
    );
    expect(reinstall).toMatchObject({
      outcome: "noop",
      reason: "no-claims",
      replayedOperationIds: [retired.operationId],
    });
    expect(eligibleAssertionCount(f.orgId, seeded.artifactId, f.pkg)).toBe(1);
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(0);
  });

  it("AC-9: a STRANDED older owed operation (empty newer op in front) is drained too — assertions not lost", () => {
    const f = freshFixture();
    expect(runInstallAnchorClaimActivation(f.input()).outcome).toBe("activated");
    const seeded = seedClassicAssertion({ orgId: f.orgId, extension: f.pkg });

    // Operation A: archives the assertion + retires the claims.
    const opA = retireArtifactExtensionClaims({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    expect(opA.archivedAssertions).toBe(1);
    // Re-activate the same claims MANUALLY via the store (the hook's own
    // pre-drain would consume op A — this reproduces the state a retire whose
    // claim-retirement half failed leaves behind), then retire again:
    // operation B is EMPTY (everything already archived) and is the LATEST
    // owed op — a latest-only replay would consume B and strand A's archived
    // assertion forever (codex High finding).
    for (const claim of f.claims) {
      const claimId = reserveArtifactTypeClaim({
        scope: f.scope,
        objectTypeId: claim.type,
        claimKind: claim.claim,
        extensionPackage: f.pkg,
        extensionVersion: "1.0.0",
        installId: null,
        dispositions: claim.dispositions,
        actor: "system",
      });
      activateArtifactTypeClaim({ claimId, actor: "system" });
    }
    const opB = retireArtifactExtensionClaims({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    expect(opB.archivedAssertions).toBe(0);

    const reinstall = runInstallAnchorClaimActivation(f.input({ installId: nextId("inst") }));
    expect(reinstall).toMatchObject({ outcome: "activated", activatedClaims: 2 });
    // BOTH owed operations drained, newest first.
    expect((reinstall as { replayedOperationIds: string[] }).replayedOperationIds).toEqual([
      opB.operationId,
      opA.operationId,
    ]);
    // Operation A's archived classic assertion is eligible again.
    expect(eligibleAssertionCount(f.orgId, seeded.artifactId, f.pkg)).toBe(1);
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(2);
  });

  it("AC-10: a drained operation with BINDING lineage forces the rewire even on a live-claims MATCH — the binding regenerates via the reconcile the reactivation enqueues", () => {
    const f = freshFixture();
    expect(runInstallAnchorClaimActivation(f.input()).outcome).toBe("activated");

    // A typed object row + the drained reconcile queue give the object a
    // BINDING-basis assertion under the dedicated claim.
    const artifactId = nextId("obj");
    sql(
      `INSERT INTO "${S()}"."objects"
         (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility)
       VALUES ($1,$2,$3,'{}'::jsonb,1,'pending','organization',$3,'organization')`,
      [artifactId, f.claims[0].type, f.orgId],
    );
    drainReconcileQueue();
    const binding = readActiveBinding(f.orgId, artifactId);
    expect(binding?.extension).toBe(f.pkg);

    // Reproduce the PARTIAL retire (codex round-2 High finding): archival ran
    // (op A completed+owed, the binding assertion archived into its lineage)
    // but claim retirement never happened — the live claims still MATCH the
    // manifest. Binding lineage is never replayed as classic, so a match
    // short-circuit after the drain would leave this binding absent forever.
    const opA = beginArtifactUninstallOperation({
      scope: f.scope,
      extensionPackage: f.pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    const archived = runArtifactUninstallArchival({ operationId: opA });
    expect(archived.archivedAssertions).toBeGreaterThanOrEqual(1);
    expect(readActiveBinding(f.orgId, artifactId)).toBeNull();
    expect(liveClaims(f.scope, f.pkg)).toHaveLength(2); // claims survived — they match

    const refire = runInstallAnchorClaimActivation(f.input({ installId: nextId("inst") }));
    expect(refire).toMatchObject({ outcome: "rewired", activatedClaims: 2 });
    expect((refire as { replayedOperationIds: string[] }).replayedOperationIds).toContain(opA);

    // The rewire's reactivation enqueued the type reconcile — draining the
    // queue regenerates the binding under the NEW claim generation.
    expect(drainReconcileQueue()).toBeGreaterThanOrEqual(1);
    const regenerated = readActiveBinding(f.orgId, artifactId);
    expect(regenerated?.extension).toBe(f.pkg);
    expect(regenerated?.bindingClaimId).not.toBe(binding?.bindingClaimId);
  });

  it("AC-11: a replayed CLASSIC row under the claiming extension's own name never wedges the type reconcile — same-fire retire→drain→replay + new dedicated claim converges (classic superseded, binding live, queue row done)", () => {
    // codex round-3 High finding #3: v1 does NOT claim :thing but wrote an ordinary live
    // CLASSIC assertion on a :thing artifact. v2 changes the claim set AND adds
    // a dedicated claim on :thing. The rewire archives the classic row
    // extension-wide, the drain immediately replays it LIVE (classic basis IS
    // replayed), and the same fire's reactivation enqueues the :thing
    // reconcile. Without the same-extension supersede in the binding reconcile
    // the winner INSERT collides with sa_active_unique_idx, the whole type
    // sweep aborts before its checkpoint, and the queue row parks 'failed' —
    // every :thing artifact stays unbound forever.
    const f = freshFixture();
    const thingType = f.claims[0].type;
    const v1Claims: LifecycleClaim[] = [f.claims[1]]; // default :note only — :thing UNCLAIMED
    expect(
      runInstallAnchorClaimActivation(f.input({ claims: v1Claims })).outcome,
    ).toBe("activated");

    const artifactId = nextId("obj");
    sql(
      `INSERT INTO "${S()}"."objects"
         (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility)
       VALUES ($1,$2,$3,'{}'::jsonb,1,'pending','organization',$3,'organization')`,
      [artifactId, thingType, f.orgId],
    );
    const classicId = nextId("sa");
    sql(
      `INSERT INTO "${S()}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility)
       VALUES ($1,$2,$3,$4,'agent','eligible')`,
      [classicId, f.orgId, artifactId, f.pkg],
    );

    // v2: claim-set CHANGE + a NEW dedicated claim over :thing → rewire.
    const refire = runInstallAnchorClaimActivation(
      f.input({ claims: f.claims, extensionVersion: "2.0.0", installId: nextId("inst") }),
    );
    expect(refire).toMatchObject({ outcome: "rewired", activatedClaims: 2 });
    expect(
      (refire as { replayedOperationIds: string[] }).replayedOperationIds,
    ).toHaveLength(1);
    // The drain replayed the archived classic row LIVE (fresh id, same slot).
    expect(eligibleAssertionCount(f.orgId, artifactId, f.pkg)).toBe(1);

    // Draining the reconcile the reactivation enqueued must CONVERGE, not park:
    // the winner's binding supersedes the same-extension replayed classic.
    expect(drainReconcileQueue()).toBeGreaterThanOrEqual(1);
    expect(readActiveBinding(f.orgId, artifactId)?.extension).toBe(f.pkg);
    expect(eligibleAssertionCount(f.orgId, artifactId, f.pkg)).toBe(1); // the binding only
    const classics = sql(
      `SELECT eligibility FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND artifact_id=$2 AND extension=$3 AND assertion_basis='classic'`,
      [f.orgId, artifactId, f.pkg],
    ).rows as Array<{ eligibility: string }>;
    expect(classics.length).toBeGreaterThanOrEqual(2); // original + replayed
    expect(classics.every((r) => r.eligibility === "archived")).toBe(true);

    // The type's binding-reconcile rows all converged — none parked, none stuck
    // pending ('re-projection' rows are a different consumer's and stay pending).
    const queue = sql(
      `SELECT status, count(*)::int AS n FROM "${S()}"."artifact_binding_reconcile_queue"
       WHERE object_type_id = $1 AND kind IN ('binding-reconcile','binding-reconcile-write')
       GROUP BY status`,
      [thingType],
    ).rows as Array<{ status: string; n: number }>;
    expect(queue.find((r) => r.status === "failed")).toBeUndefined();
    expect(queue.find((r) => r.status === "pending")).toBeUndefined();
  });
});
