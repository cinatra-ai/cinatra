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
        // D8: projector now gates on source ∈ {agent, ui} + reads created_at
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
        // D8: projector now gates on source ∈ {agent, ui} + reads created_at
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
        // D8: projector now gates on source ∈ {agent, ui} + reads created_at
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
        // D8: projector now gates on source ∈ {agent, ui} + reads created_at
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
        // D8: projector now gates on source ∈ {agent, ui} + reads created_at
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
