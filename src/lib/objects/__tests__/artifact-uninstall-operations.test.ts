import { beforeEach, describe, expect, it, vi } from "vitest";

// SQL-shape proof for the artifact-extension uninstall-operation store
// (cinatra#1432, epic #1424, AC-2). The postgres runner is mocked and we
// assert the emitted SQL / params / transaction sequence carry the safety
// properties:
//   - the archive step is ONE data-modifying CTE (archive UPDATE eligible ->
//     archived, then lineage INSERT SELECTing FROM the archived rows), so the
//     lineage is exactly-the-archived-set by construction, ON CONFLICT DO
//     NOTHING (checkpoint-resume idempotent);
//   - the replay INSERT is guarded on the artifact still existing AND no live
//     same-extension assertion (the type-changed-while-absent guard + the
//     sa_active_unique_idx invariant), defaulting assertion_basis to 'classic'
//     (never a binding);
//   - archival checkpoints by PER-BATCH delta (not the running total), and
//     reinstall replay is at-most-once (the final CAS is `replayed_at IS NULL`).
//   (The default-artifact floor + its uninstall-protection were retired in
//    epic cinatra#1785 wave A5.)

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));
// The graphiti-refresh tail is single-sourced from the assertion service;
// substitute a sentinel so this test focuses on the uninstall SQL.
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  buildGraphitiRefreshQueries: () => [{ text: "REFRESH_TAIL", values: [] }],
}));

// The uninstall-operation lineage DDL rides the claim-system schema leaf
// (cinatra#1432 — bundled to hold the drizzle-store file-size ratchet).
import { artifactUninstallOperationSchemaQueries } from "@/lib/artifact-claim-schema";
import {
  acquireArtifactRetirementOperation,
  buildArchiveArtifactAssertionsWithLineageQuery,
  buildReplayReplacementAssertionQuery,
  enumerateRetirableScopesFromStores,
  findResumableUninstallOperation,
  runArtifactUninstallArchival,
  replayArtifactUninstallOperation,
} from "@/lib/objects/artifact-uninstall-operations";

beforeEach(() => runPostgresQueriesSync.mockReset());

describe("artifactUninstallOperationSchemaQueries (bootstrap DDL)", () => {
  const sql = artifactUninstallOperationSchemaQueries("cinatra").map((q) => q.text).join("\n");
  it("creates both tables under the schema, idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "cinatra"\."artifact_uninstall_operations"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "cinatra"\."artifact_uninstall_operation_assertions"/);
  });
  it("makes the lineage append-only (UNIQUE + BEFORE UPDATE OR DELETE trigger)", () => {
    expect(sql).toMatch(/UNIQUE \(operation_id, assertion_id\)/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "cinatra"\."artifact_uninstall_operation_assertions"/);
  });
});

describe("buildArchiveArtifactAssertionsWithLineageQuery", () => {
  const q = buildArchiveArtifactAssertionsWithLineageQuery("cinatra", {
    operationId: "op1",
    orgId: "o1",
    artifactId: "a1",
    extension: "@v/pkg-artifact",
  });
  it("archives only eligible rows for (org, artifact, extension) as one CTE", () => {
    expect(q.text).toMatch(/UPDATE "cinatra"\."semantic_assertion"/);
    expect(q.text).toMatch(/SET eligibility = 'archived', archived_at = now\(\)/);
    expect(q.text).toMatch(/WHERE org_id = \$1 AND artifact_id = \$2 AND extension = \$3 AND eligibility = 'eligible'/);
  });
  it("writes lineage from the archived set incl. assertion_basis, ON CONFLICT DO NOTHING (resume-idempotent)", () => {
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."artifact_uninstall_operation_assertions"/);
    expect(q.text).toMatch(/FROM archived a/);
    // basis is denormalized so replay can restore only the classic subset.
    expect(q.text).toMatch(/RETURNING id, org_id, artifact_id, extension, asserted_by, asserted_by_principal, assertion_basis/);
    expect(q.text).toMatch(/a\.assertion_basis/);
    expect(q.text).toMatch(/ON CONFLICT \(operation_id, assertion_id\) DO NOTHING/);
    expect(q.text).toMatch(/RETURNING assertion_id/);
    expect(q.values).toEqual(["o1", "a1", "@v/pkg-artifact", "op1"]);
  });
});

describe("buildReplayReplacementAssertionQuery (type-changed-while-absent guard)", () => {
  const q = buildReplayReplacementAssertionQuery("cinatra", {
    orgId: "o1",
    artifactId: "a1",
    extension: "@v/pkg-artifact",
    assertedBy: "user",
    assertedByPrincipal: "u-1",
  });
  it("INSERTs a replacement only if the artifact exists and no live same-extension assertion exists", () => {
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."semantic_assertion"/);
    expect(q.text).toMatch(/WHERE EXISTS \(\s*SELECT 1 FROM "cinatra"\."objects" o WHERE o\.id = \$2::text AND o\.org_id = \$1::text\)/);
    expect(q.text).toMatch(/AND NOT EXISTS \(/);
    expect(q.text).toMatch(/sa\.eligibility <> 'archived'/);
  });
  it("never resurrects — always a fresh INSERT of an eligible CLASSIC assertion", () => {
    // assertion_basis is not set => defaults to 'classic'; eligibility 'eligible'.
    expect(q.text).toMatch(/'eligible'/);
    expect(q.text).not.toMatch(/assertion_basis/);
  });
});

describe("runArtifactUninstallArchival", () => {
  it("checkpoints by PER-BATCH delta (not the running total) and marks completed", () => {
    const opRow = { id: "op1", scope: "org:org-1", extension_package: "@v/pkg-artifact", extension_version: "1", actor: "u1", status: "running", archived_count: 0, checkpoint: null, replayed_at: null, replayed_install_id: null, created_at: null, completed_at: null };
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [opRow], rowCount: 1 }]) // op read
      .mockReturnValueOnce([{ rows: [{ status: "running" }], rowCount: 1 }]) // per-batch status recheck (cinatra#1837 R4a)
      .mockReturnValueOnce([{ rows: [{ org_id: "org-1", artifact_id: "a1" }], rowCount: 1 }]) // batch select (1 < batchSize -> last)
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }, { rows: [{ assertion_id: "x" }, { assertion_id: "y" }], rowCount: 2 }, { rows: [], rowCount: 0 }]) // per-artifact tx: lock, archive(2), refresh tail
      .mockReturnValueOnce([{ rows: [], rowCount: 1 }]) // checkpoint update
      .mockReturnValueOnce([{ rows: [], rowCount: 1 }]); // completed update

    const result = runArtifactUninstallArchival({ operationId: "op1" });
    expect(result).toEqual({ archivedAssertions: 2, processedArtifacts: 1 });

    const calls = runPostgresQueriesSync.mock.calls;
    const checkpointCall = calls.find((c) => String((c[0] as { queries: { text: string }[] }).queries[0].text).includes("SET checkpoint"));
    expect(checkpointCall).toBeDefined();
    const checkpointQuery = (checkpointCall![0] as { queries: { text: string; values: unknown[] }[] }).queries[0];
    expect(checkpointQuery.text).toMatch(/archived_count = archived_count \+ \$3/);
    // $3 is the PER-BATCH delta (2), not a cumulative total.
    expect(checkpointQuery.values[2]).toBe(2);
  });
});

describe("acquireArtifactRetirementOperation (R4a single-writer acquire)", () => {
  it("takes the op-key advisory lock then runs the atomic pick-or-insert CTE (ONE transaction)", () => {
    runPostgresQueriesSync.mockReturnValueOnce([
      { rows: [{}], rowCount: 1 }, // advisory lock
      { rows: [{ running_id: null, inserted_id: "new-op" }], rowCount: 1 }, // CTE
    ]);
    const res = acquireArtifactRetirementOperation({
      scope: "org:org-1",
      extensionPackage: "@v/pkg-artifact",
      extensionVersion: "1.0.0",
      actor: "u1",
    });
    expect(res).toEqual({ action: "begin", operationId: "new-op" });
    const call = runPostgresQueriesSync.mock.calls[0][0] as {
      transaction: boolean;
      queries: { text: string; values: unknown[] }[];
    };
    expect(call.transaction).toBe(true); // atomic: lock + CTE in ONE transaction
    expect(call.queries[0].text).toMatch(/pg_advisory_xact_lock/);
    expect(call.queries[0].values[0]).toBe("artifact-uninstall:org:org-1:@v/pkg-artifact");
    // The CTE self-gates the INSERT on NO running op AND eligible assertions.
    expect(call.queries[1].text).toMatch(/NOT EXISTS \(SELECT 1 FROM running\) AND EXISTS \(SELECT 1 FROM eligible\)/);
  });

  it("RESUMES an existing running op (never opens a second)", () => {
    runPostgresQueriesSync.mockReturnValueOnce([
      { rows: [{}], rowCount: 1 },
      { rows: [{ running_id: "stranded", inserted_id: null }], rowCount: 1 },
    ]);
    expect(
      acquireArtifactRetirementOperation({ scope: "org:o1", extensionPackage: "@v/pkg", extensionVersion: "1", actor: "u" }),
    ).toEqual({ action: "resume", operationId: "stranded" });
  });

  it("reports DONE when no running op and no eligible assertions (mints no empty op)", () => {
    runPostgresQueriesSync.mockReturnValueOnce([
      { rows: [{}], rowCount: 1 },
      { rows: [{ running_id: null, inserted_id: null }], rowCount: 1 },
    ]);
    expect(
      acquireArtifactRetirementOperation({ scope: "org:o1", extensionPackage: "@v/pkg", extensionVersion: "1", actor: "u" }),
    ).toEqual({ action: "done" });
  });

  it("applies the org filter to the eligible-assertion probe for an org scope", () => {
    runPostgresQueriesSync.mockReturnValueOnce([
      { rows: [{}], rowCount: 1 },
      { rows: [{ running_id: null, inserted_id: null }], rowCount: 1 },
    ]);
    acquireArtifactRetirementOperation({ scope: "org:org-7", extensionPackage: "@v/pkg", extensionVersion: "1", actor: "u" });
    const call = runPostgresQueriesSync.mock.calls[0][0] as { queries: { text: string; values: unknown[] }[] };
    expect(call.queries[1].text).toMatch(/eligibility = 'eligible' AND org_id = \$6/);
    expect(call.queries[1].values).toContain("org-7");
  });
});

describe("findResumableUninstallOperation (R4b)", () => {
  it("selects the OLDEST still-running op for (scope, package)", () => {
    runPostgresQueriesSync.mockReturnValueOnce([
      { rows: [{ id: "op1", scope: "org:o1", extension_package: "@v/pkg", extension_version: "1", actor: "u", status: "running", archived_count: 0, checkpoint: null, replayed_at: null, replayed_install_id: null, created_at: null, completed_at: null }], rowCount: 1 },
    ]);
    const row = findResumableUninstallOperation({ scope: "org:o1", extensionPackage: "@v/pkg" });
    expect(row?.id).toBe("op1");
    const call = runPostgresQueriesSync.mock.calls[0][0] as { queries: { text: string }[] };
    expect(call.queries[0].text).toMatch(/status = 'running'[\s\S]*ORDER BY created_at ASC/);
  });
});

describe("enumerateRetirableScopesFromStores (R2 union, F5)", () => {
  it("unions claim scopes + eligible-assertion orgs + not-yet-replayed op scopes (deduped)", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ scope: "org:o1" }, { scope: "platform" }], rowCount: 2 }]) // claims
      .mockReturnValueOnce([{ rows: [{ org_id: "o2" }, { org_id: "o1" }], rowCount: 2 }]) // eligible assertions
      .mockReturnValueOnce([{ rows: [{ scope: "org:o3" }], rowCount: 1 }]); // stranded ops
    const scopes = enumerateRetirableScopesFromStores("@v/pkg");
    expect(scopes.sort()).toEqual(["org:o1", "org:o2", "org:o3", "platform"]);
  });
});

describe("replayArtifactUninstallOperation binding exclusion", () => {
  it("replays CLASSIC lineage but SKIPS binding lineage (bindings regenerate via reconcile, never as classic)", () => {
    const bindingRow = { assertion_id: "b1", org_id: "o1", artifact_id: "a1", extension: "@v/pkg-artifact", asserted_by: "user", asserted_by_principal: null, assertion_basis: "binding" };
    const classicRow = { assertion_id: "c1", org_id: "o1", artifact_id: "a2", extension: "@v/pkg-artifact", asserted_by: "user", asserted_by_principal: "u1", assertion_basis: "classic" };
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [bindingRow, classicRow], rowCount: 2 }]) // lineage batch (2 < batchSize -> last)
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }, { rows: [{ id: "new" }], rowCount: 1 }, { rows: [], rowCount: 0 }]) // classic replay tx: lock, insert(1), floor
      .mockReturnValueOnce([{ rows: [], rowCount: 1 }]); // replayed CAS

    const result = replayArtifactUninstallOperation({ operationId: "op1", installId: "inst-2" });
    expect(result).toEqual({ insertedAssertions: 1, skipped: 1 });

    // Exactly one per-artifact replay tx ran, and it targeted the CLASSIC row's
    // artifact (a2) — the binding row (a1) was skipped, never inserted.
    const calls = runPostgresQueriesSync.mock.calls;
    const replayTxCalls = calls.filter((c) => {
      const qs = (c[0] as { queries: { text: string }[] }).queries;
      return qs.length >= 2 && String(qs[1].text).includes('INSERT INTO "cinatra"."semantic_assertion"');
    });
    expect(replayTxCalls).toHaveLength(1);
    const lockValues = (replayTxCalls[0][0] as { queries: { values: unknown[] }[] }).queries[0].values;
    expect(lockValues).toEqual(["a2"]);
  });
});

describe("replayArtifactUninstallOperation (at-most-once)", () => {
  it("marks the operation replayed with a `replayed_at IS NULL` CAS", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }]) // first lineage batch: empty -> loop ends
      .mockReturnValueOnce([{ rows: [], rowCount: 1 }]); // final replayed CAS

    const result = replayArtifactUninstallOperation({ operationId: "op1", installId: "inst-2" });
    expect(result).toEqual({ insertedAssertions: 0, skipped: 0 });

    const calls = runPostgresQueriesSync.mock.calls;
    const casCall = calls.find((c) => String((c[0] as { queries: { text: string }[] }).queries[0].text).includes("SET replayed_at"));
    expect(casCall).toBeDefined();
    const casQuery = (casCall![0] as { queries: { text: string; values: unknown[] }[] }).queries[0];
    expect(casQuery.text).toMatch(/WHERE id = \$1 AND replayed_at IS NULL/);
    expect(casQuery.values).toEqual(["op1", "inst-2"]);
  });
});
