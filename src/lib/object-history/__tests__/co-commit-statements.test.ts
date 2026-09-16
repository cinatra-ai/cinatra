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
//   4. omitting the option changes nothing (every existing caller is unaffected);
//   5. the seam is STRUCTURALLY closed (cinatra#1381 review, finding 7): it
//      accepts a typed descriptor from a closed set of kinds and one
//      read-shaped statement, so no caller can splice transaction control into
//      the guarded transaction it rides.
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
import type { CoCommitStatement } from "../types";
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

// The REAL statements the three allowed kinds name. They are the exact text the
// store's builders emit, because the writer's guard pins each kind to the SHAPE
// of the statement its builder produces (codex round 1 of the #1381 review
// round: a `kind` on its own is a label, not proof).
const claim: CoCommitStatement = {
  kind: "memory-promotion-approve-claim",
  text: `WITH claimed AS (
             UPDATE "cinatra"."memory_promotion_request"
             SET status = 'approved',
                 decided_by = $3,
                 decided_at = now(),
                 decision_note = $4,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2 AND status = 'pending' AND row_version = $5
             RETURNING id
           ),
           claim_assert AS (
             SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM claimed) THEN 1 ELSE 0 END AS ok
           )
           SELECT ok FROM claim_assert`,
  values: ["req-1"],
};

const containment: CoCommitStatement = {
  kind: "memory-promotion-team-containment-assert",
  text: `WITH locked AS (
             SELECT 1 AS ok
             FROM public."team" t
             WHERE t.id = $1 AND t."organizationId" = $2
             FOR SHARE
           )
           SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM locked) THEN 1 ELSE 0 END AS ok`,
  values: ["team-1", "org_1"],
};

const membership: CoCommitStatement = {
  kind: "memory-promotion-requester-membership-assert",
  text: `WITH locked AS (
             SELECT 1 AS ok
             FROM public."teamMember" tm
             WHERE tm."teamId" = $1 AND tm."userId" = $2
             FOR SHARE
           )
           SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM locked) THEN 1 ELSE 0 END AS ok`,
  values: ["team-1", "u-member"],
};

function upsert(coCommitStatements?: ReadonlyArray<CoCommitStatement>) {
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
    const result = upsert([claim, containment]);
    expect(batchStatements()).toHaveLength(3);
    expect(result.objectId).toBe("mem_1");
    expect(result.resultVersion).toBe(1);
  });

  it("copies the caller's values array rather than aliasing it", () => {
    const values = ["req-1"];
    upsert([{ kind: claim.kind, text: claim.text, values }]);
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

// ── the STRUCTURAL guard (cinatra#1381 review, finding 7) ───────────────────
//
// The seam splices caller text verbatim into the guarded batch. Before this
// guard its guarantees lived only in a doc comment, so `{ text: "COMMIT" }`
// would have ended the guarded transaction, released the advisory lock and left
// the write running outside it. Each case below is that class of statement,
// refused BEFORE anything is queued.
describe("the co-commit seam refuses a statement it cannot vouch for", () => {
  const refused: Array<[string, CoCommitStatement]> = [
    [
      "an unknown kind",
      { kind: "something-else" as CoCommitStatement["kind"], text: claim.text },
    ],
    [
      "a bare COMMIT",
      { kind: "memory-promotion-approve-claim", text: "COMMIT" },
    ],
    [
      "a bare ROLLBACK",
      { kind: "memory-promotion-approve-claim", text: "ROLLBACK" },
    ],
    [
      "a SAVEPOINT",
      { kind: "memory-promotion-approve-claim", text: "SAVEPOINT s1" },
    ],
    [
      "a BEGIN",
      { kind: "memory-promotion-approve-claim", text: "BEGIN" },
    ],
    [
      "a second statement smuggled after a separator",
      { kind: "memory-promotion-approve-claim", text: `${claim.text}; COMMIT` },
    ],
    // A kind is a LABEL. These carry a known kind and a plausible opener and
    // still do something no builder does.
    [
      "a data-modifying CTE wearing the claim's kind",
      {
        kind: "memory-promotion-approve-claim",
        text: "WITH changed AS (DELETE FROM sensitive_table RETURNING 1) SELECT count(*) FROM changed",
      },
    ],
    [
      "a write wearing an ASSERT's kind",
      {
        kind: "memory-promotion-team-containment-assert",
        text: "WITH changed AS (DELETE FROM sensitive_table RETURNING 1) SELECT count(*) FROM changed",
      },
    ],
    [
      "the claim's own text under an assert's kind",
      { kind: "memory-promotion-team-containment-assert", text: claim.text },
    ],
    [
      "a containment assert that reads a DIFFERENT table",
      {
        kind: "memory-promotion-team-containment-assert",
        text: membership.text,
      },
    ],
    [
      "a bare SELECT with no shape at all",
      { kind: "memory-promotion-approve-claim", text: "SELECT 2" },
    ],
    // codex round 2 of the #1381 review round. A full-text regex pinned the
    // builder's exact prose while leaving the TABLE and the CTE LIST to the
    // caller. These are the statements it let through.
    [
      "a claim that updates a table of the caller's choosing",
      {
        kind: "memory-promotion-approve-claim",
        text: claim.text.replace('"cinatra"."memory_promotion_request"', "public.victim"),
      },
    ],
    [
      "a claim with a second CTE appended to it",
      {
        kind: "memory-promotion-approve-claim",
        text: claim.text.replace(
          "           claim_assert AS (",
          "           evil AS (SELECT pg_sleep(60)),\n           claim_assert AS (",
        ),
      },
    ],
    [
      "an assert with a second CTE appended to it",
      {
        kind: "memory-promotion-team-containment-assert",
        text: containment.text.replace(
          "WITH locked AS (",
          "WITH evil AS (SELECT pg_sleep(60)), locked AS (",
        ),
      },
    ],
    [
      "a claim carrying a SECOND write verb",
      {
        kind: "memory-promotion-approve-claim",
        text: claim.text.replace("RETURNING id", "RETURNING (DELETE FROM other RETURNING 1)"),
      },
    ],
    // codex round 3: without a LEFT identifier boundary, any table whose name
    // ends with the allowed one passes the write-target check.
    [
      "a claim updating a table whose name merely ENDS with the allowed one",
      {
        kind: "memory-promotion-approve-claim",
        text: claim.text.replace(
          '"cinatra"."memory_promotion_request"',
          "public.victim_memory_promotion_request",
        ),
      },
    ],
    [
      "a claim updating an UNQUALIFIED table of the right name",
      {
        kind: "memory-promotion-approve-claim",
        text: claim.text.replace('"cinatra"."memory_promotion_request"', "memory_promotion_request"),
      },
    ],
    [
      "a read-only kind wearing a write",
      {
        kind: "memory-promotion-requester-membership-assert",
        text: membership.text.replace("SELECT 1 AS ok", "DELETE FROM t RETURNING 1 AS ok"),
      },
    ],
  ];

  it.each(refused)("refuses %s and queues NOTHING", (_label, statement) => {
    expect(() => upsert([statement])).toThrow(/co-commit statement/);
    expect(mocks.buildGuardedOrgWriteBatch).not.toHaveBeenCalled();
    expect(mocks.runGuardedOrgWriteBatchSync).not.toHaveBeenCalled();
  });

  it("still accepts all three real callers, in the order the apply sends them", () => {
    expect(() => upsert([containment, membership, claim])).not.toThrow();
    expect(batchStatements()).toHaveLength(4);
  });
});

// The shapes the writer pins are the shapes the STORE's builders emit. If a
// builder's text drifts, the writer refuses it and this test says so, rather
// than the drift being discovered in production.
describe("the pinned shapes match the real builders", () => {
  it("accepts the statements the memory promotion store actually produces", async () => {
    const store = await import("@/lib/objects/memory-promotion-request-store");
    const real = [
      store.buildMemoryPromotionTeamContainmentAssert({ teamId: "team-1", orgId: "org_1" }),
      store.buildMemoryPromotionRequesterMembershipAssert({ teamId: "team-1", userId: "u-member" }),
      store.buildMemoryPromotionApproveClaim({
        id: "req-1",
        orgId: "org_1",
        decidedBy: "u-admin",
        note: null,
        expectedRowVersion: 3,
      }),
    ];
    expect(() => upsert(real)).not.toThrow();
    expect(batchStatements()).toHaveLength(4);
  });
});
