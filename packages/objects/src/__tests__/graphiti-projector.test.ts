// Graphiti projector + outbox repair worker.
//
// Covers the three new exports of packages/objects/src/graphiti-projector.ts:
//   - projectObjectToGraphiti({ objectId, objectVersion, orgId })
//   - deleteCurrentEpisodeFromGraphiti({ objectId, orgId })
//   - processProjectionOutbox({ batchSize, maxAttempts })
//
// Tests mock @/lib/postgres-sync (capture SQL/values for the claim,
// markProjected, and outbox status writes) and ../graphiti-client
// (capture addEpisode / deleteEpisode invocations without hitting Graphiti).
//
// Stale-outbox guard: if the canonical row's version has
// already advanced past the outbox entry's object_version, the projector must
// short-circuit BEFORE addEpisode (no ghost episode written).
// The top-level cinatra_object_id is asserted in the expected output.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  identityHashToUuid: (h: string) => h,
}));

import {
  processProjectionOutbox,
  projectObjectToGraphiti,
  deleteCurrentEpisodeFromGraphiti,
} from "../graphiti-projector";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { addEpisode, deleteEpisode } from "../graphiti-client";
import { objectSyncAdapterRegistry } from "../sync-adapters/registry";
import type { ObjectSyncAdapter } from "../sync-adapters/adapter";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;
const addEp = addEpisode as unknown as ReturnType<typeof vi.fn>;
const delEp = deleteEpisode as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runPg.mockReset();
  addEp.mockReset();
  delEp.mockReset();
});

// ---------------------------------------------------------------------------
// processProjectionOutbox — claim pattern
// ---------------------------------------------------------------------------

describe("processProjectionOutbox — claim pattern", () => {
  it("Test 1: claim SQL uses FOR UPDATE SKIP LOCKED + status IN pending/failed + attempts < $1", async () => {
    runPg.mockReturnValue([{ rows: [] }]);
    await processProjectionOutbox({ batchSize: 5, maxAttempts: 3 });
    // calls[0] is the recovery step (reset stuck 'processing' rows).
    // calls[1] is the claim step; check that one.
    const claimSql = runPg.mock.calls[1][0].queries[0].text;
    expect(claimSql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    expect(claimSql).toMatch(/status\s+IN\s*\(\s*'pending'\s*,\s*'failed'\s*\)/i);
    expect(claimSql).toMatch(/attempts\s*<\s*\$1/);
  });

  it("Test 7: returns { processed, failed } reflecting actual counts", async () => {
    // No rows claimed → 0 processed, 0 failed.
    runPg.mockReturnValue([{ rows: [] }]);
    const result = await processProjectionOutbox({ batchSize: 5, maxAttempts: 3 });
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// projectObjectToGraphiti - append-only on upsert
// ---------------------------------------------------------------------------

describe("projection - append-only on upsert", () => {
  it("D8: source gate — row with non-cinatra source (worker) is skipped terminally (no addEpisode)", async () => {
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-bg",
        type: "test",
        data: {},
        version: 1,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        source: "worker", // explicitly NOT agent/ui → skipped
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-bg", objectVersion: 1, orgId: "org-1" });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
  });

  it("source gate regression (cinatra#1427 AC1): source='route' upload artifact row projects (faceted, uploads land)", async () => {
    // Canonical artifact creation persists source='route' for uploads
    // (artifact-creation.ts objects INSERT, type @cinatra-ai/artifact:object).
    // The gate previously dropped route rows terminally, so uploaded
    // artifacts never projected. Uses the REAL upload row shape so this test
    // also proves the route row takes the artifact-safe (faceted) projection.
    // Call order: 1) readCanonicalRow  2) semantic_assertion read (artifact
    // type + non-null org)  3+) markProjected etc.
    addEp.mockResolvedValue({ uuid: "ep-up", name: "x", content: "{}", group_id: "g" });
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-upload",
        type: "@cinatra-ai/artifact:object",
        data: {
          artifactType: "document",
          latestRepresentationRevisionId: "rep-rev-1",
          title: "quarterly report",
          mime: "application/pdf",
          // A stray non-whitelisted field must NOT reach the episode body.
          strayInternalField: "must-not-project",
        },
        version: 1,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        graphiti_projected_version: null,
        source: "route",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    runPg.mockReturnValueOnce([{ rows: [] }]); // semantic_assertion: none yet
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({
      objectId: "obj-upload",
      objectVersion: 1,
      orgId: "org-1",
    });
    expect(result.skipped).toBeUndefined();
    expect(result.episodeUuid).not.toBeNull();
    expect(addEp).toHaveBeenCalledOnce();
    // readCanonicalRow must SELECT graphiti_projected_version — the dedup
    // guard reads it off the canonical row.
    const selectSql = runPg.mock.calls[0][0].queries[0].text;
    expect(selectSql).toMatch(/graphiti_projected_version/);
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.artifactType).toBe("document");
    expect(body.title).toBe("quarterly report");
    expect(body.strayInternalField).toBeUndefined();
  });

  it("source gate: scheduler rows remain excluded after the route fix", async () => {
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-sched",
        type: "test",
        data: {},
        version: 1,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        graphiti_projected_version: null,
        source: "scheduler",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-sched", objectVersion: 1, orgId: "org-1" });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
  });

  it("upsert calls addEpisode once, never deleteEpisode", async () => {
    addEp.mockResolvedValue({ uuid: "ep-1", name: "x", content: "{}", group_id: "g" });
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-1",
        type: "test",
        data: {},
        version: 2,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        // projector now gates on source ∈ {agent, ui} + reads created_at
        // (for the adapter-routing reference_time). Tests pass "agent" so
        // the canonical/non-adapter projection path under test is exercised.
        source: "agent",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-1", objectVersion: 2, orgId: "org-1" });
    expect(addEp).toHaveBeenCalledOnce();
    expect(delEp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Version guard
// ---------------------------------------------------------------------------

describe("version guard", () => {
  it("markProjected SQL includes the version guard", async () => {
    addEp.mockResolvedValue({ uuid: "ep-1", name: "x", content: "{}", group_id: "g" });
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-1",
        type: "test",
        data: {},
        version: 5,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        // projector now gates on source ∈ {agent, ui} + reads created_at
        // (for the adapter-routing reference_time). Tests pass "agent" so
        // the canonical/non-adapter projection path under test is exercised.
        source: "agent",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-1", objectVersion: 5, orgId: "org-1" });
    const updateCall = runPg.mock.calls.find((c) =>
      /UPDATE\s+"cinatra"\."objects"/.test(c[0].queries?.[0]?.text ?? ""),
    );
    expect(updateCall).toBeDefined();
    const sql = updateCall![0].queries[0].text;
    expect(sql).toMatch(
      /graphiti_projected_version\s+IS\s+NULL\s+OR\s+graphiti_projected_version\s*<\s*\$2/i,
    );
  });

  it("stale projection with a newer persisted version is benign", async () => {
    addEp.mockResolvedValue({ uuid: "ep-1", name: "x", content: "{}", group_id: "g" });
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-1",
        type: "test",
        data: {},
        version: 5,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        // projector now gates on source ∈ {agent, ui} + reads created_at
        // (for the adapter-routing reference_time). Tests pass "agent" so
        // the canonical/non-adapter projection path under test is exercised.
        source: "agent",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 0 }]);
    await expect(
      projectObjectToGraphiti({ objectId: "obj-1", objectVersion: 5, orgId: "org-1" }),
    ).resolves.not.toThrow();
  });

  // A stale outbox row must NOT call addEpisode.
  it("stale outbox row with a newer persisted version skips addEpisode", async () => {
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-1",
        type: "test",
        data: {},
        version: 7,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        // projector now gates on source ∈ {agent, ui} + reads created_at
        // (for the adapter-routing reference_time). Tests pass "agent" so
        // the canonical/non-adapter projection path under test is exercised.
        source: "agent",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    addEp.mockResolvedValue({ uuid: "ep-1", name: "x", content: "{}", group_id: "g" });
    const result = await projectObjectToGraphiti({
      objectId: "obj-1",
      objectVersion: 3,
      orgId: "org-1",
    });
    expect(addEp).not.toHaveBeenCalled();
    expect((result as { skipped?: boolean }).skipped).toBe(true);
    expect((result as { episodeUuid: string | null }).episodeUuid).toBeNull();
    // markProjected MUST NOT have been called either (no UPDATE on objects).
    const markCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /UPDATE\s+"cinatra"\."objects"\s+SET\s+graphiti_sync_status/i.test(t);
    });
    expect(markCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Equal-version dedup (cinatra#1427 AC2)
// ---------------------------------------------------------------------------

describe("equal-version dedup", () => {
  const projectedRow = (over: Record<string, unknown> = {}) => ({
    id: "obj-1",
    type: "test",
    data: {},
    version: 3,
    org_id: "org-1",
    run_id: null,
    agent_id: null,
    graphiti_episode_uuid: "ep-existing",
    graphiti_projected_version: 3,
    source: "agent",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  });

  it("outbox item at an already-projected version skips addEpisode and markProjected", async () => {
    // Re-enqueue of an unchanged row: canonical version == outbox version ==
    // graphiti_projected_version. The old guard pair let this call addEpisode
    // again (stale guard needs a NEWER canonical version; markProjected only
    // advances on strictly newer), appending a duplicate episode.
    runPg.mockReturnValueOnce([{ rows: [projectedRow()] }]);
    const result = await projectObjectToGraphiti({
      objectId: "obj-1",
      objectVersion: 3,
      orgId: "org-1",
    });
    expect(result.skipped).toBe(true);
    expect(result.episodeUuid).toBeNull();
    expect(addEp).not.toHaveBeenCalled();
    const markCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /UPDATE\s+"cinatra"\."objects"\s+SET\s+graphiti_sync_status/i.test(t);
    });
    expect(markCall).toBeUndefined();
  });

  it("outbox item OLDER than the projected version also skips addEpisode", async () => {
    // Coherent state: canonical row advanced to v3 and v3 is projected; a
    // straggler outbox item for v2 arrives late. The stale guard fires first
    // (canonical 3 > outbox 2); the dedup guard (2 <= 3) backstops it —
    // either way, no episode is appended.
    runPg.mockReturnValueOnce([{ rows: [projectedRow({ version: 3, graphiti_projected_version: 3 })] }]);
    const result = await projectObjectToGraphiti({
      objectId: "obj-1",
      objectVersion: 2,
      orgId: "org-1",
    });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
  });

  it("adapter-owned type: equal-version re-enqueue skips adapter.export too (no duplicate adapter episode)", async () => {
    // The dedup guard sits BEFORE adapter routing, so an adapter-backed row
    // re-enqueued at its already-projected version never re-exports.
    const exportFn = vi.fn();
    objectSyncAdapterRegistry.register({
      id: "test-graphiti-adapter",
      targetSystem: "graphiti",
      displayName: "Test Graphiti Adapter",
      supportedTypes: ["adapter-owned-type"],
      configSchema: undefined as never,
      export: exportFn,
    } as unknown as ObjectSyncAdapter);
    try {
      runPg.mockReturnValueOnce([{
        rows: [projectedRow({ type: "adapter-owned-type" })],
      }]);
      const result = await projectObjectToGraphiti({
        objectId: "obj-1",
        objectVersion: 3,
        orgId: "org-1",
      });
      expect(result.skipped).toBe(true);
      expect(exportFn).not.toHaveBeenCalled();
      expect(addEp).not.toHaveBeenCalled();
    } finally {
      objectSyncAdapterRegistry._clearForTests();
    }
  });

  it("a NEWER outbox version than the projected one still projects", async () => {
    addEp.mockResolvedValue({ uuid: "ep-2", name: "x", content: "{}", group_id: "g" });
    runPg.mockReturnValueOnce([{ rows: [projectedRow({ version: 4, graphiti_projected_version: 3 })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({
      objectId: "obj-1",
      objectVersion: 4,
      orgId: "org-1",
    });
    expect(result.skipped).toBeUndefined();
    expect(addEp).toHaveBeenCalledOnce();
  });

  it("never-projected row (graphiti_projected_version NULL) projects normally", async () => {
    addEp.mockResolvedValue({ uuid: "ep-1", name: "x", content: "{}", group_id: "g" });
    runPg.mockReturnValueOnce([{
      rows: [projectedRow({ graphiti_projected_version: null, graphiti_episode_uuid: null })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({
      objectId: "obj-1",
      objectVersion: 3,
      orgId: "org-1",
    });
    expect(result.skipped).toBeUndefined();
    expect(addEp).toHaveBeenCalledOnce();
  });

  it("re-enqueued unchanged row settles the outbox row as done with zero new episodes (worker loop)", async () => {
    // End-to-end at the processProjectionOutbox level: the skip is a SUCCESS
    // outcome — the outbox row must settle 'done' (not 'failed'), and
    // addEpisode must never fire.
    // Call order: 1) stuck-row recovery  2) claim  3) readCanonicalRow
    // 4) outbox status update.
    runPg.mockReturnValueOnce([{ rows: [] }]);
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "ob-requeue",
        object_id: "obj-1",
        object_version: 3,
        org_id: "org-1",
        operation: "upsert",
        payload_hash: null,
        attempts: 1,
      }],
    }]);
    runPg.mockReturnValueOnce([{ rows: [projectedRow()] }]);
    runPg.mockReturnValue([{ rows: [] }]);

    const result = await processProjectionOutbox({ batchSize: 5, maxAttempts: 3 });
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(addEp).not.toHaveBeenCalled();
    const doneCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return (
        /UPDATE\s+"cinatra"\."graphiti_projection_outbox"/.test(t) &&
        /'done'/.test(t)
      );
    });
    expect(doneCall).toBeDefined();
    expect(doneCall![0].queries[0].values).toContain("ob-requeue");
    const failedCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return (
        /UPDATE\s+"cinatra"\."graphiti_projection_outbox"/.test(t) &&
        /SET\s+status\s*=\s*'failed'/i.test(t) &&
        !/recovered from stuck/.test(t)
      );
    });
    expect(failedCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Delete operation
// ---------------------------------------------------------------------------

describe("delete operation", () => {
  it("Test 5: delete calls deleteEpisode with current graphiti_episode_uuid", async () => {
    runPg.mockReturnValue([{
      rows: [{
        id: "obj-1",
        type: "test",
        data: {},
        version: 1,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: "ep-old",
      }],
    }]);
    delEp.mockResolvedValue(undefined);
    await deleteCurrentEpisodeFromGraphiti({ objectId: "obj-1", orgId: "org-1" });
    expect(delEp).toHaveBeenCalledWith({ uuid: "ep-old" });
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("failure handling", () => {
  it("Test 3: addEpisode rejection marks outbox row failed + bumps attempts", async () => {
    // The first call is the recovery step (resets stuck 'processing' rows).
    runPg.mockReturnValueOnce([{ rows: [] }]);
    // 1) Claim returns one row.
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "ob-1",
        object_id: "obj-1",
        object_version: 1,
        org_id: "org-1",
        operation: "upsert",
        payload_hash: null,
        attempts: 1,
      }],
    }]);
    // 2) readCanonicalRow returns canonical row.
    runPg.mockReturnValueOnce([{
      rows: [{
        id: "obj-1",
        type: "test",
        data: {},
        version: 1,
        org_id: "org-1",
        run_id: null,
        agent_id: null,
        graphiti_episode_uuid: null,
        // projector now gates on source ∈ {agent, ui} + reads created_at
        // (for the adapter-routing reference_time). Tests pass "agent" so
        // the canonical/non-adapter projection path under test is exercised.
        source: "agent",
        created_at: "2026-01-01T00:00:00Z",
      }],
    }]);
    // 3) addEpisode rejects.
    addEp.mockRejectedValueOnce(new Error("graphiti down"));
    // 4) Subsequent UPDATE statements (failed status + canonical observability) succeed.
    runPg.mockReturnValue([{ rows: [] }]);

    const result = await processProjectionOutbox({ batchSize: 5, maxAttempts: 3 });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const failedUpdateCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return (
        /UPDATE\s+"cinatra"\."graphiti_projection_outbox"/.test(t) &&
        /'failed'|last_error/.test(t)
      );
    });
    expect(failedUpdateCall).toBeDefined();
  });
});
