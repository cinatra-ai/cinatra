// cinatra#1381 — the CO-COMMIT seam, which is what makes memory promotion's
// apply ATOMIC.
//
// The issue's atomic-apply bullet says one transaction must carry the request's
// CAS transition, the row's CAS widen, the immutable history append and the
// durable Graphiti re-projection enqueue. The last three were already one
// statement inside the canonical writer's guarded batch; this seam is how the
// FIRST one joins them.
//
// What is proven here:
//   1. co-commit statements are appended INSIDE the org-write-guarded batch,
//      AHEAD of the write, so they run under the same advisory lock and the
//      same capability guard — not in a second transaction;
//   2. the write's own result is still the LAST batch entry, whatever the
//      caller prepends (the #1939 Stage D correctness property);
//   3. a co-commit statement that RAISES aborts the whole apply — the widen,
//      its history event and its outbox row go with it;
//   4. omitting the option changes nothing (every existing caller is unaffected).
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  buildGuardedOrgWriteBatch: vi.fn(),
  runGuardedOrgWriteBatchSync: vi.fn(),
  runPostgresQueriesSync: vi.fn(() => [{ rows: [] as Array<Record<string, unknown>>, rowCount: 0 }]),
}));

vi.mock("@cinatra-ai/org-write-kernel", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildGuardedOrgWriteBatch: mocks.buildGuardedOrgWriteBatch };
});
vi.mock("@/lib/org-write/batch-wrapper", () => ({
  runGuardedOrgWriteBatchSync: mocks.runGuardedOrgWriteBatchSync,
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: mocks.runPostgresQueriesSync }));
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgres://stub",
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/mcp-request-context", () => ({
  mcpRequestContextStorage: { getStore: () => undefined },
}));
vi.mock("@/lib/project-writable", () => ({ assertProjectWritableSync: () => {} }));
vi.mock("@/lib/project-inheritance", () => ({ resolveProjectInheritanceForType: () => null }));
vi.mock("../change-set", () => ({
  openChangeSet: () => ({ changeSetId: "cs_cocommit" }),
  closeChangeSet: () => {},
}));

import { historyAwareUpsert } from "../canonical-writer";
import { VersionConflictError } from "../errors";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

const authority: OrgWriteAuthority = { orgId: "org_1", can: () => true };

/** The batch the writer would build. The mocked kernel returns the statement
 *  array itself so the test can read exactly what was queued, in order. */
function batchStatements(): Array<{ text: string; values?: unknown[] }> {
  return mocks.buildGuardedOrgWriteBatch.mock.calls.at(-1)![1] as Array<{
    text: string;
    values?: unknown[];
  }>;
}

const claim = {
  text: "WITH claimed AS (UPDATE memory_promotion_request SET status = 'approved' WHERE id = $1) SELECT 1",
  values: ["req-1"],
};

function upsert(coCommitStatements?: Array<{ text: string; values?: unknown[] }>) {
  return historyAwareUpsert(
    { id: "mem_1", type: "@cinatra-ai/memory:concept", data: { conceptId: "a" }, orgId: "org_1" },
    {
      expectedBaseVersion: null,
      historyEffect: "reversible-internal",
      actor: { actorId: "u_admin", actorKind: "user", orgId: "org_1" },
      authority,
      ...(coCommitStatements ? { coCommitStatements } : {}),
    },
  );
}

beforeEach(() => {
  mocks.buildGuardedOrgWriteBatch.mockReset();
  mocks.runGuardedOrgWriteBatchSync.mockReset();
  mocks.buildGuardedOrgWriteBatch.mockImplementation((_req: unknown, queries: unknown) => queries);
  // The guarded batch prepends lock/refusal/guard rows in production; the
  // writer reads its own result off the LAST entry either way.
  mocks.runGuardedOrgWriteBatchSync.mockImplementation((queries: Array<unknown>) =>
    queries.map((_q, i) =>
      i === queries.length - 1
        ? { rows: [{ id: "mem_1", version: 1, row_json: { id: "mem_1", version: 1 } }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    ),
  );
});

describe("co-commit statements ride the SAME guarded transaction", () => {
  it("are queued INSIDE the guarded batch, AHEAD of the object write", () => {
    upsert([claim]);
    const queued = batchStatements();
    expect(queued).toHaveLength(2);
    expect(queued[0].text).toBe(claim.text);
    expect(queued[0].values).toEqual(["req-1"]);
    // The write itself is last, and it is the one carrying the objects UPDATE /
    // INSERT, its history event and its Graphiti outbox row.
    expect(queued[1].text).toContain('"objects"');
    expect(queued[1].text).toContain("graphiti_projection_outbox");
    expect(queued[1].text).toContain("object_change_event");
  });

  it("go through the SAME capability-guarded request as the write — not a second batch", () => {
    upsert([claim]);
    expect(mocks.buildGuardedOrgWriteBatch).toHaveBeenCalledTimes(1);
    expect(mocks.runGuardedOrgWriteBatchSync).toHaveBeenCalledTimes(1);
    expect(mocks.buildGuardedOrgWriteBatch.mock.calls[0][0]).toMatchObject({
      orgId: "org_1",
      capability: "content.write",
    });
  });

  it("preserves the write's result as the LAST batch entry", () => {
    const result = upsert([claim, { text: "SELECT 2" }]);
    expect(batchStatements()).toHaveLength(3);
    expect(result.objectId).toBe("mem_1");
    expect(result.resultVersion).toBe(1);
  });

  it("copies the caller's values array rather than aliasing it", () => {
    const values = ["req-1"];
    upsert([{ text: claim.text, values }]);
    expect(batchStatements()[0].values).toEqual(values);
    expect(batchStatements()[0].values).not.toBe(values);
  });

  it("a co-commit statement that RAISES aborts the whole apply", () => {
    // The claim's own `1/0` assert raises exactly like the writer's CAS does,
    // so the write, its history event and its outbox row never commit.
    mocks.runGuardedOrgWriteBatchSync.mockImplementation(() => {
      throw new Error("division by zero");
    });
    expect(() => upsert([claim])).toThrow(VersionConflictError);
  });

  it("changes NOTHING when omitted — the existing single-statement batch", () => {
    upsert();
    const queued = batchStatements();
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toContain('"objects"');
  });
});
