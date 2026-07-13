// Projection-policy epoch bumps + the durable, epoch-fenced group rebuild
// driver (cinatra#1427 ACs 4-5). Unit layer: the pure SQL BUILDERS (exercised
// against a real DB in src/lib/__tests__/integration/) and the entry-point
// result mapping / orchestration (runPostgresQueriesSync + graphiti-client
// mocked). The kill-resume / rollback END-TO-END behaviour is proven in the
// real-DB integration suite.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("./graphiti-client", () => ({
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  clearGraph: vi.fn(async () => undefined),
  identityHashToUuid: (h: string) => h,
}));

import {
  buildEpochBumpQuery,
  buildReplayBatchQuery,
  buildOpenRollbackRebuildQuery,
  bumpProjectionPolicyEpochsFromClaimChanges,
  openRollbackRebuild,
  driveGraphitiRebuild,
  processGraphitiProjectionCycle,
  REBUILD_JOURNAL_PHASES,
  deriveProjectionGroupId,
  readProjectionEpochs,
} from "../graphiti-rebuild";
import { orgIdFromProjectionGroupId } from "../graphiti-projection-policy";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => runPg.mockReset());

function pgRouter(routes: Array<[RegExp, unknown]>) {
  return (arg: { queries?: Array<{ text?: string }> }) => {
    const text = arg?.queries?.[0]?.text ?? "";
    for (const [pattern, result] of routes) if (pattern.test(text)) return result;
    return [{ rows: [], rowCount: 0 }];
  };
}

// ---------------------------------------------------------------------------
// Group-id helpers + phase vocabulary.
// ---------------------------------------------------------------------------

describe("group-id helpers", () => {
  it("deriveProjectionGroupId / orgIdFromProjectionGroupId round-trip", () => {
    expect(deriveProjectionGroupId("org-1")).toBe("cinatra-org-org-1");
    expect(deriveProjectionGroupId(null)).toBe("cinatra-default");
    expect(orgIdFromProjectionGroupId("cinatra-org-org-1")).toBe("org-1");
    expect(orgIdFromProjectionGroupId("cinatra-default")).toBeNull();
    expect(orgIdFromProjectionGroupId("nonsense")).toBeNull();
  });

  it("phase vocabulary is the ordered clearing→replaying→verifying→done machine", () => {
    expect(REBUILD_JOURNAL_PHASES).toEqual(["clearing", "replaying", "verifying", "done"]);
  });
});

describe("readProjectionEpochs", () => {
  it("returns the implicit epoch 1 for a group with no policy row", () => {
    runPg.mockReturnValue([{ rows: [{ group_id: "cinatra-org-org-1", epoch: 4 }] }]);
    const map = readProjectionEpochs(["cinatra-org-org-1", "cinatra-default"]);
    expect(map.get("cinatra-org-org-1")).toBe(4);
    expect(map.get("cinatra-default")).toBe(1); // no row ⇒ implicit 1
  });

  it("empty input issues no query", () => {
    const map = readProjectionEpochs([]);
    expect(map.size).toBe(0);
    expect(runPg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SQL builders (shape assertions; real-DB behaviour in the integration suite).
// ---------------------------------------------------------------------------

describe("buildEpochBumpQuery", () => {
  const sql = buildEpochBumpQuery("cinatra", 200).text;

  it("drains PENDING 're-projection' queue rows with FOR UPDATE SKIP LOCKED", () => {
    expect(sql).toMatch(/kind\s*=\s*'re-projection'\s+AND\s+status\s*=\s*'pending'/i);
    expect(sql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    expect(sql).toMatch(/SET\s+status\s*=\s*'done'/i);
  });

  it("derives affected groups only from types that actually have rows (scope-gated join)", () => {
    expect(sql).toMatch(/JOIN\s+"cinatra"\."objects"\s+o/i);
    expect(sql).toMatch(/o\.type\s*=\s*c\.object_type_id/i);
    expect(sql).toMatch(/c\.scope\s*=\s*'platform'/i);
    expect(sql).toMatch(/o\.org_id\s*=\s*substring\(c\.scope\s+from\s+5\)/i);
  });

  it("bumps the group epoch (+1) and folds a second bump into the one open journal", () => {
    expect(sql).toMatch(/epoch\s*=\s*"graphiti_projection_policy"\.epoch\s*\+\s*1/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(group_id\)\s+WHERE\s+phase\s*<>\s*'done'/i);
    expect(sql).toMatch(/phase\s*=\s*'clearing'/i); // fold resets to clearing
    expect(sql).toMatch(/foldCount/);
  });
});

describe("buildReplayBatchQuery", () => {
  const sql = buildReplayBatchQuery("cinatra", { journalId: "j1", toEpoch: 3, batchSize: 200 }).text;

  it("enqueues epoch-STAMPED outbox items behind the source gate", () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+"cinatra"\."graphiti_projection_outbox"/i);
    expect(sql).toMatch(/projection_epoch/i);
    expect(sql).toMatch(/o\.source\s+IS\s+NULL\s+OR\s+o\.source\s+IN\s*\('agent','ui','route'\)/i);
  });

  it("advances the checkpoint cursor atomically with the batch (id-window, ordered)", () => {
    expect(sql).toMatch(/o\.id\s*>\s*j\.last_id/i);
    expect(sql).toMatch(/ORDER\s+BY\s+o\.id/i);
    expect(sql).toMatch(/'lastObjectId',\s*\(SELECT\s+max\(object_id\)\s+FROM\s+ins\)/i);
    expect(sql).toMatch(/\(SELECT\s+count\(\*\)\s+FROM\s+ins\)\s*>\s*0/i);
  });

  it("only replays live rows of the journal's group", () => {
    expect(sql).toMatch(/o\.deleted_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/j\.org_id\s+IS\s+NULL\s+AND\s+o\.org_id\s+IS\s+NULL/i);
  });
});

describe("buildOpenRollbackRebuildQuery", () => {
  it("is a monotonic epoch bump + a fenced rollback rebuild, carrying org id + provenance", () => {
    const q = buildOpenRollbackRebuildQuery("cinatra", {
      groupId: "cinatra-org-org-1",
      orgId: "org-1",
      rolledBackJournalId: "j-old",
    });
    expect(q.values).toEqual(["cinatra-org-org-1", "org-1", "j-old"]);
    expect(q.text).toMatch(/epoch\s*=\s*"graphiti_projection_policy"\.epoch\s*\+\s*1/i);
    expect(q.text).toMatch(/'kind',\s*'rollback'/i);
    expect(q.text).toMatch(/ON\s+CONFLICT\s*\(group_id\)\s+WHERE\s+phase\s*<>\s*'done'/i);
  });
});

// ---------------------------------------------------------------------------
// Entry-point result mapping / orchestration.
// ---------------------------------------------------------------------------

describe("bumpProjectionPolicyEpochsFromClaimChanges", () => {
  it("maps the consumed count + per-group bumps from the atomic statement", () => {
    runPg.mockReturnValue([
      { rows: [{ consumed: 3, bumps: [{ groupId: "cinatra-org-org-1", toEpoch: 2 }] }] },
    ]);
    const out = bumpProjectionPolicyEpochsFromClaimChanges();
    expect(out.consumed).toBe(3);
    expect(out.bumps).toEqual([{ groupId: "cinatra-org-org-1", toEpoch: 2 }]);
  });

  it("nothing pending ⇒ zero consumed, no bumps", () => {
    runPg.mockReturnValue([{ rows: [{ consumed: 0, bumps: [] }] }]);
    const out = bumpProjectionPolicyEpochsFromClaimChanges();
    expect(out).toEqual({ consumed: 0, bumps: [] });
  });
});

describe("openRollbackRebuild", () => {
  it("derives the org id from the group id and returns the new fenced epoch", () => {
    runPg.mockReturnValue([{ rows: [{ group_id: "cinatra-org-org-1", to_epoch: 5 }] }]);
    const out = openRollbackRebuild({ groupId: "cinatra-org-org-1", rolledBackJournalId: "j-old" });
    expect(out).toEqual({ groupId: "cinatra-org-org-1", toEpoch: 5 });
  });

  it("throws when no journal row comes back (never silently succeeds)", () => {
    runPg.mockReturnValue([{ rows: [] }]);
    expect(() => openRollbackRebuild({ groupId: "cinatra-default" })).toThrow(/no journal row/i);
  });
});

describe("driveGraphitiRebuild", () => {
  it("no open journals ⇒ advances nothing, reports zero open", async () => {
    runPg.mockImplementation(
      pgRouter([
        [/count\(\*\)::int\s+AS\s+open/i, [{ rows: [{ open: 0 }] }]],
        [/FROM\s+"cinatra"\."graphiti_rebuild_journal"/i, [{ rows: [] }]],
      ]),
    );
    const out = await driveGraphitiRebuild();
    expect(out).toEqual({ advanced: 0, errored: 0, open: 0 });
  });
});

describe("processGraphitiProjectionCycle", () => {
  it("runs all three stages and returns a well-formed cycle result even when idle", async () => {
    runPg.mockReturnValue([{ rows: [], rowCount: 0 }]);
    const out = await processGraphitiProjectionCycle({ batchSize: 20, maxAttempts: 5 });
    expect(out).toEqual({
      claimChangesConsumed: 0,
      epochBumps: 0,
      journalsAdvanced: 0,
      journalsOpen: 0,
      processed: 0,
      failed: 0,
    });
  });
});
