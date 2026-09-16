import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3272 — SQL-shape proof for the artifact promotion request store's CAS
// decide. The postgres runner is mocked, so what is measured here is the
// statement the store EMITS and the cause it reports:
//   - a reject that asserts the decider's MEMBERSHIP inside the same statement,
//     row-locked, so a revocation between the ladder's pre-check and this write
//     cannot slip underneath it;
//   - both counts read from ONE snapshot, so a lost CAS names its own cause
//     instead of being explained by a second read of a newer world;
//   - the APPROVE claim, which carries its membership half inside the atomic
//     widen instead, emits no membership arm at all.
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { casDecideArtifactPromotionRequest } from "../artifact-promotion-request-store";

function lastQuery(): { text: string; values?: unknown[] } {
  const call = runPostgresQueriesSync.mock.calls.at(-1)![0] as {
    queries: Array<{ text: string; values?: unknown[] }>;
  };
  return call.queries[0]!;
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
  runPostgresQueriesSync.mockReturnValue([{ rows: [{ updated: 1, member: 1 }], rowCount: 1 }]);
});

describe("the CAS decide statement", () => {
  it("CASes pending -> rejected, org-scoped, and never names the objects table", () => {
    casDecideArtifactPromotionRequest({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      decision: "reject",
      note: "dup",
    });
    const q = lastQuery();
    expect(q.text).toContain("WHERE id = $1 AND org_id = $2 AND status = 'pending'");
    expect(q.text).not.toMatch(/"objects"/);
    expect(q.values).toEqual(["req-1", "org-1", "rejected", "u-admin", "dup"]);
  });

  // THE CONDITION INSIDE THE COMPARE-AND-SET. The ladder's membership pre-check
  // and this write are two operations; a membership revoked in between would
  // otherwise let a now-non-member reject an organization's request for good.
  it("carries the decider's MEMBERSHIP inside the same statement, with a row lock", () => {
    casDecideArtifactPromotionRequest({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      decision: "reject",
      note: "dup",
      requireMemberUserId: "u-admin",
    });
    const q = lastQuery();
    expect(q.text).toContain('FROM public."member" m');
    expect(q.text).toContain('WHERE m."organizationId" = $2 AND m."userId" = $6');
    expect(q.text).toContain("AND EXISTS (SELECT 1 FROM member_locked)");
    // FOR SHARE, so a concurrent revocation waits for this statement rather
    // than committing underneath it.
    expect(q.text).toMatch(/FOR SHARE/);
    expect(q.values).toEqual(["req-1", "org-1", "rejected", "u-admin", "dup", "u-admin"]);
  });

  it("returns the membership count alongside the update count, from ONE snapshot", () => {
    casDecideArtifactPromotionRequest({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      decision: "reject",
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
      casDecideArtifactPromotionRequest({
        id: "req-1",
        orgId: "org-1",
        decidedBy: "u-admin",
        decision: "reject",
        requireMemberUserId: "u-admin",
      }),
    ).toEqual(expected);
  });

  // The approve claim's membership half is the org-write authority minted inside
  // the atomic widen, so its statement is the one it always was.
  it("omits the membership arm entirely when no membership is required (the approve claim)", () => {
    casDecideArtifactPromotionRequest({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      decision: "approve",
      note: null,
    });
    const q = lastQuery();
    expect(q.text).not.toContain('public."member"');
    expect(q.text).toContain("SET status = $3");
    expect(q.values).toEqual(["req-1", "org-1", "approved", "u-admin", null]);
  });
});
