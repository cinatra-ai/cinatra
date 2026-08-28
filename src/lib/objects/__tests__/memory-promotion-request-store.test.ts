import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#1381 — SQL-shape proof for the memory promotion request store. The
// postgres runner is mocked and the emitted SQL / params carry the safety
// properties this issue is measured on:
//   - the APPROVE claim is a STATEMENT (never executed here) whose CAS pins
//     status='pending' AND the captured row_version, and which ASSERTS its own
//     rowCount in SQL so a lost claim aborts the co-committed transaction;
//   - the reject / supersede transitions CAS on 'pending' and touch nothing
//     else;
//   - every read is org-scoped;
//   - the advisory duplicate query can never see a PRIVATE row, computes the
//     comparison key on BOTH sides from the subject row itself (so a caller
//     cannot supply a probe key), and asks only about the target audience.
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { MEMORY_PROMOTION_REQUEST_TABLE, memoryPromotionRequestSchemaQueries } from "../memory-promotion-request-schema";
import {
  buildMemoryPromotionApproveClaim,
  buildMemoryPromotionRequesterMembershipAssert,
  buildMemoryPromotionTeamContainmentAssert,
  casRejectMemoryPromotionRequest,
  countAudienceVisibleMemoryDuplicates,
  countMemoryPromotionRequests,
  listMemoryPromotionRequests,
  markMemoryPromotionRequestSuperseded,
  readMemoryPromotionRequestById,
} from "../memory-promotion-request-store";

function lastQuery(): { text: string; values?: unknown[] } {
  const call = runPostgresQueriesSync.mock.calls.at(-1)![0] as {
    queries: Array<{ text: string; values?: unknown[] }>;
  };
  return call.queries[0];
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
  runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 0 }]);
});

describe("the approve claim statement (the atomic-apply half)", () => {
  it("is BUILT, never run — building it issues no query at all", () => {
    buildMemoryPromotionApproveClaim({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      note: null,
      expectedRowVersion: 3,
    });
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("CASes on pending AND the captured row_version, scoped to the org", () => {
    const stmt = buildMemoryPromotionApproveClaim({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      note: "useful",
      expectedRowVersion: 3,
    });
    expect(stmt.text).toContain("WHERE id = $1 AND org_id = $2 AND status = 'pending' AND row_version = $5");
    expect(stmt.text).toContain("SET status = 'approved'");
    expect(stmt.values).toEqual(["req-1", "org-1", "u-admin", "useful", 3]);
  });

  it("ASSERTS its own rowCount in SQL, so a lost claim raises and aborts the transaction", () => {
    const stmt = buildMemoryPromotionApproveClaim({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      expectedRowVersion: 3,
    });
    // The division-by-zero assert — the same idiom the canonical writer's own
    // CAS uses, which is why the decide path re-reads to classify.
    expect(stmt.text).toMatch(/1 \/ CASE WHEN EXISTS \(SELECT 1 FROM claimed\) THEN 1 ELSE 0 END/);
  });

  it("writes NOTHING but the request row — no objects touch anywhere in the statement", () => {
    const stmt = buildMemoryPromotionApproveClaim({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      expectedRowVersion: 3,
    });
    expect(stmt.text).not.toMatch(/"objects"/);
    expect(stmt.text).not.toMatch(/graphiti_projection_outbox/);
  });
});

describe("the team-containment assert (the co-committed one)", () => {
  it("is BUILT, never run", () => {
    buildMemoryPromotionTeamContainmentAssert({ teamId: "team-9", orgId: "org-1" });
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("asserts the team is in THIS organization and raises when it is not", () => {
    const stmt = buildMemoryPromotionTeamContainmentAssert({ teamId: "team-9", orgId: "org-1" });
    expect(stmt.text).toContain('FROM public."team" t');
    expect(stmt.text).toContain('WHERE t.id = $1 AND t."organizationId" = $2');
    expect(stmt.text).toMatch(/1 \/ CASE WHEN EXISTS/);
    expect(stmt.values).toEqual(["team-9", "org-1"]);
  });

  it("LOCKS the team row for the rest of the transaction (codex round 2, finding 1)", () => {
    // Without the lock the predicate is a TOCTOU read: a concurrent delete or
    // an organization move committing between this statement and the promotion
    // commit would leave a foreign team as the row's owner, with nothing
    // failing. FOR SHARE (not FOR KEY SHARE — an organization move is a
    // non-key update) makes such a writer wait for this transaction.
    const stmt = buildMemoryPromotionTeamContainmentAssert({ teamId: "team-9", orgId: "org-1" });
    expect(stmt.text).toMatch(/FOR SHARE/);
    expect(stmt.text).not.toMatch(/FOR KEY SHARE/);
  });

  it("writes nothing — it is a predicate, not a mutation", () => {
    const stmt = buildMemoryPromotionTeamContainmentAssert({ teamId: "team-9", orgId: "org-1" });
    expect(stmt.text).not.toMatch(/UPDATE|INSERT|DELETE/);
  });
});

// cinatra#1381 review, finding 4. Approve re-checked the TEAM's containment but
// not the REQUESTER's membership, so a requester removed from the target team
// while their request sat pending still got the row moved into it.
describe("the requester-membership assert (the second co-committed one)", () => {
  it("is BUILT, never run", () => {
    buildMemoryPromotionRequesterMembershipAssert({ teamId: "team-9", userId: "u-member" });
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("asserts THIS user is in THAT team and raises when they are not", () => {
    const stmt = buildMemoryPromotionRequesterMembershipAssert({ teamId: "team-9", userId: "u-member" });
    expect(stmt.text).toContain('FROM public."teamMember" tm');
    expect(stmt.text).toContain('WHERE tm."teamId" = $1 AND tm."userId" = $2');
    expect(stmt.text).toMatch(/1 \/ CASE WHEN EXISTS/);
    expect(stmt.values).toEqual(["team-9", "u-member"]);
  });

  it("LOCKS the membership row, so a concurrent removal cannot commit underneath", () => {
    const stmt = buildMemoryPromotionRequesterMembershipAssert({ teamId: "team-9", userId: "u-member" });
    expect(stmt.text).toMatch(/FOR SHARE/);
  });

  it("writes nothing: it is a predicate, not a mutation", () => {
    const stmt = buildMemoryPromotionRequesterMembershipAssert({ teamId: "team-9", userId: "u-member" });
    expect(stmt.text).not.toMatch(/UPDATE|INSERT|DELETE/);
  });
});

// Both co-commit statements and the claim carry a TYPED kind, so the canonical
// writer's co-commit seam can refuse anything else (review finding 7).
describe("every co-commit statement names its kind", () => {
  it("tags the claim and both asserts with the kind the writer allows", () => {
    expect(
      buildMemoryPromotionApproveClaim({
        id: "req-1",
        orgId: "org-1",
        decidedBy: "u-admin",
        expectedRowVersion: 3,
      }).kind,
    ).toBe("memory-promotion-approve-claim");
    expect(buildMemoryPromotionTeamContainmentAssert({ teamId: "t", orgId: "o" }).kind).toBe(
      "memory-promotion-team-containment-assert",
    );
    expect(buildMemoryPromotionRequesterMembershipAssert({ teamId: "t", userId: "u" }).kind).toBe(
      "memory-promotion-requester-membership-assert",
    );
  });
});

// cinatra#1381 review, finding 8, the single mutation survivor. Replacing the
// UNIQUE constraint with an always-true CHECK left every suite green, because
// the store suite only asserted that a duplicate-key ERROR maps to `conflict`,
// which a hand-thrown error satisfies. The one-pending rule is a property of
// the emitted DDL, so it is asserted over the emitted DDL. The two-transaction
// race that proves the constraint actually fires lives in
// `memory-promotion-atomic-apply.integration.test.ts`, against a real database.
describe("the one-pending constraint is in the emitted DDL", () => {
  const createTable = () => {
    const stmt = memoryPromotionRequestSchemaQueries("cinatra").find((q) =>
      q.text.includes(`CREATE TABLE IF NOT EXISTS "cinatra"."${MEMORY_PROMOTION_REQUEST_TABLE}"`),
    );
    if (!stmt) throw new Error("no CREATE TABLE statement emitted");
    return stmt.text;
  };

  it("emits a UNIQUE constraint over the generated pending_object_id column", () => {
    expect(createTable()).toContain("CONSTRAINT mpr_one_pending UNIQUE (pending_object_id)");
  });

  it("generates pending_object_id as object_id WHILE PENDING and NULL otherwise", () => {
    // UNIQUE does not conflict NULLs, so this is what lets any number of DECIDED
    // requests for one row coexist while at most one PENDING request may exist.
    expect(createTable()).toContain(
      "pending_object_id  text GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN object_id END) STORED",
    );
  });

  it("expresses the rule as a table CONSTRAINT, never a separate CREATE UNIQUE INDEX", () => {
    // A standalone CREATE UNIQUE INDEX on an existing table is what the
    // schema-migration gate refuses without a migration artifact. The DDL's own
    // comments discuss that phrase, so match the EXECUTABLE text only.
    const executable = (text: string) => text.replace(/--[^\n]*/g, "");
    for (const q of memoryPromotionRequestSchemaQueries("cinatra")) {
      expect(executable(q.text)).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    }
  });
});

describe("the request-only transitions", () => {
  it("reject CASes pending -> rejected and never names the objects table", () => {
    casRejectMemoryPromotionRequest({ id: "req-1", orgId: "org-1", decidedBy: "u-admin", note: "dup" });
    const q = lastQuery();
    expect(q.text).toContain("SET status = 'rejected'");
    expect(q.text).toContain("WHERE id = $1 AND org_id = $2 AND status = 'pending'");
    expect(q.text).not.toMatch(/"objects"/);
    expect(q.values).toEqual(["req-1", "org-1", "u-admin", "dup"]);
  });

  // codex round 1 of the #1381 review round. The ladder's membership pre-check
  // and this write are two operations; a membership revoked in between would
  // otherwise let a now-non-member reject an organization's request for good.
  it("carries the decider's MEMBERSHIP inside the same statement, with a row lock", () => {
    casRejectMemoryPromotionRequest({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      note: "dup",
      requireMemberUserId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text).toContain('FROM public."member" m');
    expect(q.text).toContain('WHERE m."organizationId" = $2 AND m."userId" = $5');
    expect(q.text).toContain("AND EXISTS (SELECT 1 FROM member_locked)");
    // FOR SHARE, so a concurrent revocation waits for this statement rather
    // than committing underneath it.
    expect(q.text).toMatch(/FOR SHARE/);
    expect(q.values).toEqual(["req-1", "org-1", "u-admin", "dup", "u-admin"]);
  });

  // codex round 2 of the #1381 review round: a lost CAS has two causes and one
  // rowCount, so the statement measures BOTH at its own snapshot rather than
  // leaving the caller to ask a second time about a newer world.
  it("returns the membership count alongside the update count, from ONE snapshot", () => {
    casRejectMemoryPromotionRequest({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      requireMemberUserId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text).toContain("(SELECT count(*) FROM updated)::int AS updated");
    expect(q.text).toContain("(SELECT count(*) FROM member_locked)::int AS member");
  });

  it.each([
    ["a win", { updated: 1, member: 1 }, { ok: true }],
    ["a lost membership arm", { updated: 0, member: 0 }, { ok: false, reason: "not_a_member" }],
    ["a concurrent decider", { updated: 0, member: 1 }, { ok: false, reason: "not_pending" }],
  ])("maps %s to its own cause", (_label, row, expected) => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [row], rowCount: 1 }]);
    expect(
      casRejectMemoryPromotionRequest({
        id: "req-1",
        orgId: "org-1",
        decidedBy: "u-admin",
        requireMemberUserId: "u-admin",
      }),
    ).toEqual(expected);
  });

  it("omits the membership arm entirely when no membership is required", () => {
    casRejectMemoryPromotionRequest({ id: "req-1", orgId: "org-1", decidedBy: "u-admin" });
    expect(lastQuery().text).not.toContain('public."member"');
  });

  it("supersede CASes pending -> superseded and never names the objects table", () => {
    markMemoryPromotionRequestSuperseded({ id: "req-1", orgId: "org-1" });
    const q = lastQuery();
    expect(q.text).toContain("SET status = 'superseded'");
    expect(q.text).toContain("status = 'pending'");
    expect(q.text).not.toMatch(/"objects"/);
  });
});

describe("reads are org-scoped", () => {
  it("reading one request pins org_id", () => {
    readMemoryPromotionRequestById("req-1", "org-1");
    expect(lastQuery().text).toContain("WHERE id = $1 AND org_id = $2");
    expect(lastQuery().values).toEqual(["req-1", "org-1"]);
  });

  it("the inbox list excludes the reviewer's own rows, org-scoped and bounded", () => {
    listMemoryPromotionRequests({ orgId: "org-1", status: "pending", excludeRequester: "u-admin" });
    const q = lastQuery();
    expect(q.text).toContain("org_id = $1");
    expect(q.text).toContain("requested_by <> $3");
    expect(q.text).toMatch(/LIMIT \$4/);
    expect(q.values).toEqual(["org-1", "pending", "u-admin", 200]);
  });

  it("counts are org-scoped", () => {
    countMemoryPromotionRequests({ orgId: "org-1", status: "pending", requestedBy: "u-member" });
    expect(lastQuery().text).toContain("WHERE org_id = $1 AND status = $2 AND requested_by = $3");
  });
});

describe("the advisory duplicate query — AC4's privacy properties, in the SQL", () => {
  it("NEVER counts a private row", () => {
    countAudienceVisibleMemoryDuplicates({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: "@cinatra-ai/memory:concept",
      toVisibility: "organization",
      toOwnerId: "org-1",
      viewerId: "u-admin",
    });
    expect(lastQuery().text).toContain("other.visibility <> 'private'");
  });

  it("asks only about the ORGANIZATION audience for an org target", () => {
    countAudienceVisibleMemoryDuplicates({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: "@cinatra-ai/memory:concept",
      toVisibility: "organization",
      toOwnerId: "org-1",
      viewerId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text).toContain("(other.visibility = 'organization')");
    // No team clause at all, so the org target cannot see team-owned rows.
    expect(q.text).not.toContain("other.owner_level = 'team'");
    expect(q.values).toEqual(["org-1", "mem-1", "@cinatra-ai/memory:concept"]);
  });

  // cinatra#1381 review, finding 6. `owner_level = 'organization'` was an arm of
  // the audience predicate on BOTH targets. It is a NEAR-MISS of the reader's
  // rule: `organization/team` is a legal tuple and no clause in
  // `derived-store-ownership.ts` admits it to an ordinary member or admin, so
  // the arm let the count be raised by a row the approver cannot read. It is the
  // same existence-oracle class the team arm was narrowed to close.
  it.each(["organization", "team"] as const)(
    "never asks about org-OWNED rows by owner level alone (%s target)",
    (toVisibility) => {
      countAudienceVisibleMemoryDuplicates({
        orgId: "org-1",
        objectId: "mem-1",
        objectType: "@cinatra-ai/memory:concept",
        toVisibility,
        toOwnerId: toVisibility === "team" ? "team-9" : "org-1",
        viewerId: "u-admin",
      });
      expect(lastQuery().text).not.toContain("other.owner_level = 'organization'");
    },
  );

  it("adds ONLY the target team's own rows for a team target — never a user-owned team-visible row", () => {
    countAudienceVisibleMemoryDuplicates({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: "@cinatra-ai/memory:concept",
      toVisibility: "team",
      toOwnerId: "team-9",
      viewerId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text).toContain("other.owner_level = 'team' AND other.owner_id = $4");
    // The asymmetry deriveScopeLane documents: `visibility = 'team'` alone is
    // NOT team-readable, so it must not appear as an audience clause.
    expect(q.text).not.toContain("other.visibility = 'team'");
    expect(q.values).toEqual(["org-1", "mem-1", "@cinatra-ai/memory:concept", "team-9", "u-admin"]);
  });

  it("counts a TEAM's own rows only for a VIEWER who is a member of that team (codex round 1, finding 2)", () => {
    countAudienceVisibleMemoryDuplicates({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: "@cinatra-ai/memory:concept",
      toVisibility: "team",
      toOwnerId: "team-9",
      viewerId: "u-admin",
    });
    const q = lastQuery();
    // The team clause is GATED on the viewer's own membership, so an org admin
    // reviewing a promotion into a team they are not in cannot learn what that
    // team already holds. The org-visible clause is unaffected — those rows are
    // readable by the reviewer anyway.
    expect(q.text).toMatch(
      /EXISTS \(SELECT 1 FROM public\."teamMember" tm[\s\S]*tm\."teamId" = \$4 AND tm\."userId" = \$5\)/,
    );
  });

  it("derives the comparison key on BOTH sides from the subject row — no caller-supplied probe key", () => {
    countAudienceVisibleMemoryDuplicates({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: "@cinatra-ai/memory:concept",
      toVisibility: "organization",
      toOwnerId: "org-1",
      viewerId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text).toContain("JOIN \"cinatra\".\"objects\" subj");
    expect(q.text).toContain("subj.id = $2 AND subj.org_id = $1");
    // The key expression appears for BOTH aliases and is compared to itself.
    expect(q.text).toMatch(/lower\(btrim\(coalesce\(other\.data->'frontmatter'->>'title', other\.data->>'conceptId', ''\)\)\)\s*=\s*lower\(btrim\(coalesce\(subj\.data->'frontmatter'->>'title', subj\.data->>'conceptId', ''\)\)\)/);
    // No parameter carries a title/key — only org, object id, type and team.
    expect(q.values).toEqual(["org-1", "mem-1", "@cinatra-ai/memory:concept"]);
  });

  it("returns a COUNT and never row content", () => {
    countAudienceVisibleMemoryDuplicates({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: "@cinatra-ai/memory:concept",
      toVisibility: "organization",
      toOwnerId: "org-1",
      viewerId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text.trimStart().startsWith("SELECT COUNT(*)::int AS count")).toBe(true);
    expect(q.text).not.toMatch(/SELECT[\s\S]*other\.data(?!->)/);
    // Tombstoned rows and the subject itself are excluded.
    expect(q.text).toContain("other.deleted_at IS NULL");
    expect(q.text).toContain("other.id <> subj.id");
  });
});
