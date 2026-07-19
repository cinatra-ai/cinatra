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
  readClaimedTypeDispositions,
  laneEligibleTypes,
  REBUILD_JOURNAL_PHASES,
  deriveProjectionGroupId,
  readProjectionEpochs,
} from "../graphiti-rebuild";
import { orgIdFromProjectionGroupId } from "../graphiti-projection-policy";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { objectTypeRegistry } from "../registry";
import type { TypeDispositions } from "../types";
import { z } from "zod";

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
  // Lane-eligible set = memory literal + generic artifact literal + the org's
  // artifact-safe-disposed claimed types (a dynamic bind value, #1436 AC4).
  const LANE_TYPES = ["@cinatra-ai/memory:concept", "@cinatra-ai/artifact:object", "@acme/crm:ticket"];
  const built = buildReplayBatchQuery("cinatra", { journalId: "j1", toEpoch: 3, batchSize: 200, laneEligibleTypes: LANE_TYPES });
  const sql = built.text;

  it("enqueues epoch-STAMPED outbox items behind the source gate", () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+"cinatra"\."graphiti_projection_outbox"/i);
    expect(sql).toMatch(/projection_epoch/i);
    expect(sql).toMatch(/o\.source\s+IS\s+NULL\s+OR\s+o\.source\s+IN\s*\('agent','ui','route'\)/i);
  });

  it("serializes concurrent replay drivers on the journal row (FOR UPDATE)", () => {
    // Two drivers must not read the same checkpoint and double-enqueue a batch.
    expect(sql).toMatch(/phase\s*=\s*'replaying'\s+AND\s+to_epoch\s*=\s*\$2\s+FOR\s+UPDATE/i);
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

  it("EXCLUDES only NON-AMBIENT lane-eligible rows via a PARAMETERISED type set — ambient-scoped rebuild like any ambient row (#1379 memory + #1436 artifact)", () => {
    // A lane-eligible row (memory, generic artifact, or an artifact-safe claimed
    // type) whose derived lane is NOT the ambient base lane (nested
    // user/team/project lane, OR a public/unclassifiable terminal skip) must be
    // excluded: replaying a nested one duplicates its uncleared nested episode,
    // counting a skip one inflates `expected` with no episode — both diverge
    // verification. But org/workspace-scoped ones live in the ambient group
    // clearGraph DID clear, so they stay in the replay (the NULL-safe
    // ambient-base complement keeps exactly those).
    //
    // The type set is a BIND PARAM (never spliced) — claimed type ids are
    // extension-controlled. The memory + generic-artifact literals + the org's
    // artifact-safe claimed types travel as the $4 value.
    expect(sql).toMatch(/NOT\s*\(+\s*o\.type\s*=\s*ANY\(\$4::text\[\]\)/i);
    expect(sql).not.toMatch(/o\.type\s*=\s*'@cinatra-ai\/memory:concept'/i); // no spliced literal
    expect(built.values).toContainEqual(LANE_TYPES);
    expect(sql).toMatch(/o\.visibility\s+IS\s+DISTINCT\s+FROM\s+'public'/i);
    expect(sql).toMatch(/o\.owner_level\s+IS\s+DISTINCT\s+FROM\s+'team'/i);
    expect(sql).toMatch(/o\.visibility\s*=\s*'organization'\s+OR\s+o\.owner_level\s+IN\s*\('organization',\s*'workspace'\)/i);
    expect(sql).toMatch(/o\.project_id\s+IS\s+NULL\s*\n?\s*\)\s+IS\s+NOT\s+TRUE/i);
  });

  it("REPLAY carve-out (#1436): excludes only a genuinely-nested episode OR a public skip — a stale-ambient / never-projected transition row STAYS in the replay", () => {
    // The replay/reset predicate is episode-LOCATION aware: a lane-eligible
    // non-ambient row is excluded only when it is public (never projected) OR its
    // projected_group_id is a real NESTED lane (episode outside the cleared
    // ambient group). A nested-scope row whose projected_group_id is the ambient
    // base (raw/unclaimed -> artifact-safe: base episode wiped) OR NULL (none ->
    // artifact-safe: never projected) is NOT excluded, so the projector creates
    // its nested episode instead of stranding it. The base-lane expression
    // mirrors deriveProjectionGroupId.
    expect(sql).toMatch(/o\.visibility\s*=\s*'public'\s*\n?\s*OR\s*\(\s*o\.projected_group_id\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/o\.projected_group_id\s+IS\s+DISTINCT\s+FROM/i);
    expect(sql).toMatch(/CASE\s+WHEN\s+o\.org_id\s+IS\s+NULL\s+THEN\s+'cinatra-default'\s+ELSE\s+'cinatra-org-'\s*\|\|\s*o\.org_id\s+END/i);
  });
});

describe("lane-eligible type set (#1436 AC4)", () => {
  const MEM = "@cinatra-ai/memory:concept";
  const ARTIFACT = "@cinatra-ai/artifact:object";

  it("laneEligibleTypes always leads with the memory + generic-artifact literals", () => {
    expect(laneEligibleTypes([])).toEqual([MEM, ARTIFACT]);
    expect(laneEligibleTypes(["@acme/crm:ticket"])).toEqual([MEM, ARTIFACT, "@acme/crm:ticket"]);
  });

  // Register a disposition-GOVERNED type in the type-driven registry (the
  // authority the retirement replaced the per-org DB claim with).
  const register = (type: string, dispositions: TypeDispositions) =>
    objectTypeRegistry.register({
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      dispositions,
    });

  it("readClaimedTypeDispositions(null) reads no registry and returns empty sets", () => {
    objectTypeRegistry._clearForTests();
    register("@acme/t:safe", { projection: "artifact-safe" });
    const out = readClaimedTypeDispositions(null);
    expect(out).toEqual({ excludedTypes: [], artifactSafeTypes: [] });
    // No DB read on the type-driven path.
    expect(runPg).not.toHaveBeenCalled();
  });

  it("classifies each governed type's disposition: artifact-safe (incl. bridge-default + fail-closed) vs none vs raw", () => {
    objectTypeRegistry._clearForTests();
    register("@acme/t:safe-explicit", { projection: "artifact-safe" });
    // The bridge writes an explicit artifact-safe payload when a manifest omits
    // dispositions — a governed type at the default.
    register("@acme/t:safe-default", { projection: "artifact-safe" });
    // An invalid declared projection fails closed DOWN to artifact-safe.
    register("@acme/t:safe-failclosed", {
      projection: "totally-bogus" as unknown as TypeDispositions["projection"],
    });
    register("@acme/t:raw", { projection: "raw" });
    register("@acme/t:none", { projection: "none" });
    // An UNGOVERNED data type (no dispositions) is in NEITHER set.
    objectTypeRegistry.register({
      type: "@acme/crm:account",
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
    });

    const out = readClaimedTypeDispositions("org-1");
    // Artifact-safe (lane-eligible): explicit + bridge-default + invalid-fail-closed.
    expect(out.artifactSafeTypes.sort()).toEqual(
      ["@acme/t:safe-default", "@acme/t:safe-explicit", "@acme/t:safe-failclosed"].sort(),
    );
    // 'none' → excluded from counts; 'raw' + ungoverned are in NEITHER set.
    expect(out.excludedTypes).toEqual(["@acme/t:none"]);
    expect(out.artifactSafeTypes).not.toContain("@acme/t:raw");
    expect(out.excludedTypes).not.toContain("@acme/t:raw");
    expect(out.artifactSafeTypes).not.toContain("@acme/crm:account");
    expect(out.excludedTypes).not.toContain("@acme/crm:account");
    // The full lane-eligible set threaded into the exclusion carries the literals + the artifact-safe governed types.
    const laneSet = laneEligibleTypes(out.artifactSafeTypes);
    expect(laneSet).toContain(MEM);
    expect(laneSet).toContain(ARTIFACT);
    expect(laneSet).toContain("@acme/t:safe-default");
    expect(laneSet).not.toContain("@acme/t:raw");
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
