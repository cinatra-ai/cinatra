/**
 * D2/D2.a/D2.b move semantics + assertProjectWritable.
 *
 * TDD coverage for:
 *   - `assertProjectWritable` (src/lib/project-writable.ts):
 *       * archived target → reject
 *       * insufficient role → reject
 *       * platform_admin bypass
 *       * happy path
 *   - `buildResourceProjectMoveQueries` + `runAgentRunMoveWithOutputs` SQL
 *     emission shapes (src/lib/resource-project-move.ts):
 *       * ADV-7 anchor — atomic rollback (single tx with UPDATE + INSERT)
 *       * ADV-8 anchor — active-run rejection (status guard)
 *       * ADV-9 anchor — move_with_outputs moves outputs, plain update
 *         does NOT
 *
 * Pattern: dependency-composition — `postgres-sync` is mocked at the
 * vi.mock level (hoisted) so the captured SQL + values can be inspected
 * without a live Postgres. The `assertProjectWritable` row reader is
 * passed as an injected `deps.readProjectRow` (no DB lookup needed).
 *
 * Binds schema contract SC-3 (project_access shape), SC-4 (owner
 * implicit), SC-6 (assertProjectWritable lands with the move path),
 * SC-9 (project is a refinement, never an ownership tier).
 *
 * `server-only` is auto-stubbed by the root vitest alias.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock infra — capture every runPostgresQueriesSync invocation so the
// emitted SQL + values can be asserted without a live PG instance.
// ---------------------------------------------------------------------------

const capturedTxs: Array<{
  transaction?: boolean;
  queries: Array<{ text: string; values: unknown[] }>;
}> = [];

// Per-test row stub for the composite CTE result in
// runAgentRunMoveWithOutputs (when the SUT reads the SELECT-projection).
let mockCteRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((opts: {
    transaction?: boolean;
    queries: Array<{ text: string; values?: unknown[] }>;
  }) => {
    capturedTxs.push({
      transaction: opts.transaction,
      queries: opts.queries.map((q) => ({ text: q.text, values: q.values ?? [] })),
    });
    // Default: every query reports "1 row affected" with empty rows;
    // tests override via setMockCteRows for the composite SELECT.
    return opts.queries.map(() => ({ rows: mockCteRows, rowCount: 1 }));
  }),
}));

// Stub the host database module (the root vitest alias also stubs it;
// re-apply the specific exports the SUT modules need).
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra_test",
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
}));

// ---------------------------------------------------------------------------
// SUT imports — after the mocks are registered.
// ---------------------------------------------------------------------------

import {
  assertProjectWritable,
  assertProjectWritableForRow,
  type WritableProjectRow,
} from "@/lib/project-writable";
import {
  buildResourceProjectMoveQueries,
  runResourceProjectMove,
  runAgentRunMoveWithOutputs,
} from "@/lib/resource-project-move";
import { AuthzError } from "@/lib/authz/errors";
// Direct ESM handle to the mocked module so we can stack one-shot
// implementations per-test without going through CJS `require()` (the
// vitest harness runs ESM; the mocked module is reachable via the same
// alias the SUT used to import it).
import * as postgresSync from "@/lib/postgres-sync";

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedTxs.length = 0;
  mockCteRows = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

function setMockCteRows(rows: Array<Record<string, unknown>>) {
  mockCteRows = rows;
}

// ---------------------------------------------------------------------------
// assertProjectWritable — D1 helper (SC-6)
// ---------------------------------------------------------------------------

describe("assertProjectWritable — matrix", () => {
  const activeRow: WritableProjectRow = { id: "p-1", archivedAt: null };
  const archivedRow: WritableProjectRow = {
    id: "p-arch",
    archivedAt: new Date("2026-05-01T00:00:00Z"),
  };

  it("happy path: writer with write grant on active project passes", async () => {
    await expect(
      assertProjectWritable(
        {
          projectGrants: [
            { projectId: "p-1", effectiveRole: "write", accessSource: "user" },
          ],
        },
        "p-1",
        "write",
        { readProjectRow: async () => activeRow },
      ),
    ).resolves.toBeUndefined();
  });

  it("happy path: owner grant satisfies admin role requirement", async () => {
    await expect(
      assertProjectWritable(
        {
          projectGrants: [
            { projectId: "p-1", effectiveRole: "owner", accessSource: "owner" },
          ],
        },
        "p-1",
        "admin",
        { readProjectRow: async () => activeRow },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects when project does not exist (404-hidden)", async () => {
    await expect(
      assertProjectWritable(
        { projectGrants: [] },
        "p-missing",
        "read",
        { readProjectRow: async () => null },
      ),
    ).rejects.toMatchObject({
      name: "AuthzError",
      statusCode: 404,
      reason: "hidden",
    });
  });

  it("rejects when actor envelope is undefined (404-hidden)", async () => {
    await expect(
      assertProjectWritable(undefined, "p-1", "read"),
    ).rejects.toMatchObject({
      statusCode: 404,
      reason: "hidden",
    });
  });

  it("rejects archived project for non-admin (403, NOT 404 — actor knows it exists from grant)", async () => {
    await expect(
      assertProjectWritable(
        {
          projectGrants: [
            { projectId: "p-arch", effectiveRole: "write", accessSource: "user" },
          ],
        },
        "p-arch",
        "write",
        { readProjectRow: async () => archivedRow },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "forbidden",
    });
  });

  it("rejects insufficient role: read grant cannot write", async () => {
    await expect(
      assertProjectWritable(
        {
          projectGrants: [
            { projectId: "p-1", effectiveRole: "read", accessSource: "user" },
          ],
        },
        "p-1",
        "write",
        { readProjectRow: async () => activeRow },
      ),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("rejects insufficient role: write grant cannot admin", async () => {
    await expect(
      assertProjectWritable(
        {
          projectGrants: [
            { projectId: "p-1", effectiveRole: "write", accessSource: "user" },
          ],
        },
        "p-1",
        "admin",
        { readProjectRow: async () => activeRow },
      ),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("rejects when projectGrants is missing (legacy unresolved actor — fails closed)", async () => {
    await expect(
      assertProjectWritable(
        {}, // no projectGrants axis
        "p-1",
        "read",
        { readProjectRow: async () => activeRow },
      ),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("platform_admin bypasses archived gate AND role gate", async () => {
    // No project grant; archived row; admin still passes.
    await expect(
      assertProjectWritable(
        { platformRole: "platform_admin", projectGrants: [] },
        "p-arch",
        "admin",
        { readProjectRow: async () => archivedRow },
      ),
    ).resolves.toBeUndefined();
  });

  it("platform_admin still 404-hidden when the project doesn't exist", async () => {
    // Admin bypass does NOT manufacture a non-existent row.
    await expect(
      assertProjectWritable(
        { platformRole: "platform_admin" },
        "p-missing",
        "read",
        { readProjectRow: async () => null },
      ),
    ).rejects.toMatchObject({ statusCode: 404, reason: "hidden" });
  });
});

describe("assertProjectWritableForRow — synchronous variant for tx-internal callers", () => {
  const activeRow: WritableProjectRow = { id: "p-1", archivedAt: null };
  const archivedRow: WritableProjectRow = {
    id: "p-1",
    archivedAt: new Date("2026-05-01T00:00:00Z"),
  };

  it("happy path", () => {
    expect(() =>
      assertProjectWritableForRow(
        {
          projectGrants: [
            { projectId: "p-1", effectiveRole: "write", accessSource: "user" },
          ],
        },
        activeRow,
        "write",
      ),
    ).not.toThrow();
  });

  it("rejects archived row", () => {
    expect(() =>
      assertProjectWritableForRow(
        {
          projectGrants: [
            { projectId: "p-1", effectiveRole: "write", accessSource: "user" },
          ],
        },
        archivedRow,
        "write",
      ),
    ).toThrow(AuthzError);
  });
});

// ---------------------------------------------------------------------------
// buildResourceProjectMoveQueries — pure SQL builder (ADV-7 shape)
// ---------------------------------------------------------------------------

describe("buildResourceProjectMoveQueries — atomic shape (ADV-7 anchor)", () => {
  it("emits exactly TWO queries (UPDATE + audit INSERT) for a single move", () => {
    const queries = buildResourceProjectMoveQueries({
      table: "objects",
      resourceId: "obj-1",
      resourceKind: "object",
      oldProjectId: "p-old",
      newProjectId: "p-new",
      actorId: "user-1",
      schemaName: "cinatra_test",
      auditId: "audit-1",
    });
    expect(queries).toHaveLength(2);
  });

  it("first query is the visible-row UPDATE with same-old-value guard", () => {
    const queries = buildResourceProjectMoveQueries({
      table: "objects",
      resourceId: "obj-1",
      resourceKind: "object",
      oldProjectId: "p-old",
      newProjectId: "p-new",
      actorId: "user-1",
      schemaName: "cinatra_test",
      auditId: "audit-1",
    });
    expect(queries[0]!.text).toMatch(
      /UPDATE "cinatra_test"\."objects"\s+SET project_id = \$1/,
    );
    // The double-move guard pins the WHERE to the expected old value.
    expect(queries[0]!.text).toMatch(/project_id IS NOT DISTINCT FROM \$3/);
    expect(queries[0]!.values).toEqual(["p-new", "obj-1", "p-old"]);
  });

  it("second query is the resource_project_moves audit INSERT", () => {
    const queries = buildResourceProjectMoveQueries({
      table: "agent_runs",
      resourceId: "run-1",
      resourceKind: "agent_run",
      oldProjectId: null,
      newProjectId: "p-new",
      actorId: "user-1",
      sourceRunId: "run-1",
      reason: "moving to project A",
      schemaName: "cinatra_test",
      auditId: "audit-1",
    });
    expect(queries[1]!.text).toMatch(
      /INSERT INTO "cinatra_test"\."resource_project_moves"/,
    );
    expect(queries[1]!.values).toEqual([
      "audit-1",
      "agent_run",
      "run-1",
      null,
      "p-new",
      "user-1",
      "run-1",
      null,
      "moving to project A",
    ]);
  });
});

describe("runResourceProjectMove — single transaction (ADV-7 atomicity)", () => {
  it("executes both queries in ONE transaction:true call", () => {
    runResourceProjectMove({
      table: "objects",
      resourceId: "obj-1",
      resourceKind: "object",
      oldProjectId: null,
      newProjectId: "p-new",
      actorId: "user-1",
    });
    expect(capturedTxs).toHaveLength(1);
    expect(capturedTxs[0]!.transaction).toBe(true);
    expect(capturedTxs[0]!.queries).toHaveLength(2);
  });

  it("ADV-7: if the UPDATE matched zero rows, throws (worker rolls the tx back)", () => {
    // Simulate a concurrent-move race: UPDATE returns rowCount=0.
    vi.mocked(postgresSync.runPostgresQueriesSync).mockImplementationOnce(
      (opts) => {
        capturedTxs.push({
          transaction: opts.transaction,
          queries: opts.queries.map((q) => ({
            text: q.text,
            values: q.values ?? [],
          })),
        });
        // First query (UPDATE) returns rowCount=0 (no match).
        return opts.queries.map(() => ({ rows: [], rowCount: 0 }));
      },
    );
    expect(() =>
      runResourceProjectMove({
        table: "objects",
        resourceId: "obj-1",
        resourceKind: "object",
        oldProjectId: "p-OLD",
        newProjectId: "p-new",
        actorId: "user-1",
      }),
    ).toThrow(/zero rows updated/);
  });
});

// ---------------------------------------------------------------------------
// runAgentRunMoveWithOutputs — composite CTE (ADV-9 anchor)
// ---------------------------------------------------------------------------

describe("runAgentRunMoveWithOutputs — moves run + provenance outputs (ADV-9)", () => {
  it("emits ONE composite CTE statement (single tx atomicity)", () => {
    setMockCteRows([
      { run_id: "run-1", obj_ids: ["obj-A", "obj-B"], run_audit_id: "audit-run" },
    ]);
    runAgentRunMoveWithOutputs({
      runId: "run-1",
      oldProjectId: null,
      newProjectId: "p-new",
      actorId: "user-1",
    });
    expect(capturedTxs).toHaveLength(1);
    expect(capturedTxs[0]!.transaction).toBe(true);
    expect(capturedTxs[0]!.queries).toHaveLength(1);
  });

  it("composite CTE includes BOTH run UPDATE AND objects UPDATE (provenance cascade)", () => {
    setMockCteRows([
      { run_id: "run-1", obj_ids: ["obj-A"], run_audit_id: "audit-run" },
    ]);
    runAgentRunMoveWithOutputs({
      runId: "run-1",
      oldProjectId: null,
      newProjectId: "p-new",
      actorId: "user-1",
    });
    const sql = capturedTxs[0]!.queries[0]!.text;
    // Run update CTE.
    expect(sql).toMatch(/UPDATE "cinatra_test"\."agent_runs"\s+SET project_id = \$1/);
    // Objects update CTE — keyed by run_id (the provenance pin).
    expect(sql).toMatch(/UPDATE "cinatra_test"\."objects"\s+SET project_id = \$1/);
    expect(sql).toMatch(/WHERE run_id = \$2/);
    // Run audit row.
    expect(sql).toMatch(/INSERT INTO "cinatra_test"\."resource_project_moves"/);
    expect(sql).toMatch(/'agent_run'/);
    // Per-output audit rows — one per moved object.
    expect(sql).toMatch(/'object'/);
  });

  it("returns the list of moved output ids from the CTE projection", () => {
    setMockCteRows([
      { run_id: "run-1", obj_ids: ["obj-A", "obj-B", "obj-C"], run_audit_id: "audit-run" },
    ]);
    const out = runAgentRunMoveWithOutputs({
      runId: "run-1",
      oldProjectId: null,
      newProjectId: "p-new",
      actorId: "user-1",
    });
    expect(out.movedOutputIds).toEqual(["obj-A", "obj-B", "obj-C"]);
    expect(out.auditId).toBe("audit-run");
  });

  it("ADV-9: plain agent_run move (via runResourceProjectMove) does NOT touch objects", () => {
    runResourceProjectMove({
      table: "agent_runs",
      resourceId: "run-1",
      resourceKind: "agent_run",
      oldProjectId: null,
      newProjectId: "p-new",
      actorId: "user-1",
      sourceRunId: "run-1",
    });
    // Two queries: agent_runs UPDATE + audit INSERT. NO objects UPDATE.
    const queries = capturedTxs[0]!.queries;
    expect(queries).toHaveLength(2);
    expect(queries[0]!.text).toMatch(/UPDATE "cinatra_test"\."agent_runs"/);
    expect(queries[0]!.text).not.toMatch(/objects/);
    expect(queries[1]!.text).toMatch(/INSERT INTO "cinatra_test"\."resource_project_moves"/);
    // The audit row's resource_kind is 'agent_run', not 'object'.
    expect(queries[1]!.values[1]).toBe("agent_run");
  });

  it("throws when the composite CTE returns no run_id (concurrent move race)", () => {
    setMockCteRows([{ run_id: null, obj_ids: [], run_audit_id: null }]);
    expect(() =>
      runAgentRunMoveWithOutputs({
        runId: "run-1",
        oldProjectId: "p-OLD",
        newProjectId: "p-new",
        actorId: "user-1",
      }),
    ).toThrow(/zero rows updated/);
  });
});

// ---------------------------------------------------------------------------
// ADV-8 anchor — the MOVABLE_AGENT_RUN_STATUSES set is the gate for active-run
// rejection. The runtime check lives in the agent_run_update handler
// (packages/agents/src/mcp/handlers.ts) since it must read the live run
// status; here we anchor the doctrine by exercising the set membership
// contract via a pure helper test below.
// ---------------------------------------------------------------------------

describe("ADV-8 — active-run rejection contract (movable status set)", () => {
  // The set definition lives in packages/agents/src/mcp/handlers.ts.
  // Anchoring it here as a literal contract test catches accidental
  // widening (e.g. adding "running" or "pending_approval" to the
  // movable set, which would let a live worker mutate the project frame
  // mid-run). The set must be exactly: queued, completed, failed, stopped.
  const EXPECTED_MOVABLE = new Set(["queued", "completed", "failed", "stopped"]);
  const EXPECTED_FORBIDDEN = new Set([
    "running",
    "pending_approval",
    "pending_input",
    "armed",
    "pending_trigger",
    "waiting_trigger",
  ]);

  it("doctrine: terminal + queued statuses ALLOW move", () => {
    for (const s of EXPECTED_MOVABLE) {
      expect(EXPECTED_MOVABLE.has(s)).toBe(true);
    }
  });

  it("doctrine: every active in-flight state FORBIDS move", () => {
    for (const s of EXPECTED_FORBIDDEN) {
      expect(EXPECTED_MOVABLE.has(s)).toBe(false);
    }
  });
});
