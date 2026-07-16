import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Dormant-thread mirror backfill (cinatra#1218 S2 residual 2).
// Pins: dormancy keyset pagination; per-thread TRANSACTIONAL execution of the
// P2b mirror builders with a NULL explicit org anchor (no session at boot;
// set-once keeps it repairable); soft-failing rows; malformed payloads shadow
// identity-only; the kill switch.
// ---------------------------------------------------------------------------

const runPostgresQueriesSync = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => {},
}));

import {
  parseThreadPayloadForMirror,
  runDormantAssistantThreadMirrorBackfill,
} from "../assistant-thread-mirror-backfill";
import { buildLegacyMirrorTurnId } from "../project-inheritance";

function dormantRow(id: string, payload: unknown): { id: string; payload: string } {
  return { id, payload: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CINATRA_ASSISTANT_THREAD_BACKFILL;
});

describe("parseThreadPayloadForMirror", () => {
  it("parses the payload and pins the ROW id as authoritative", () => {
    const t = parseThreadPayloadForMirror(dormantRow("th-1", { id: "spoofed", title: "T" }));
    expect(t.id).toBe("th-1");
    expect(t.title).toBe("T");
  });
  it("degrades a malformed payload to an identity-only shadow", () => {
    expect(parseThreadPayloadForMirror(dormantRow("th-1", "{not json"))).toEqual({ id: "th-1" });
    expect(parseThreadPayloadForMirror(dormantRow("th-1", "[1,2]"))).toEqual({ id: "th-1" });
  });
});

describe("runDormantAssistantThreadMirrorBackfill", () => {
  it("mirrors each dormant thread transactionally via the P2b builders (org anchor NULL)", () => {
    const payload = {
      title: "Dormant thread",
      ownerUserId: "user-7",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      messages: [
        { id: "m1", role: "user", content: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "m2", role: "assistant", content: "hi", authorUserId: "asst-1" },
      ],
    };
    runPostgresQueriesSync
      // 1st call: the dormancy SELECT (batch 1)
      .mockReturnValueOnce([{ rows: [dormantRow("th-1", payload)] }])
      // 2nd call: the per-thread mirror transaction
      .mockReturnValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }])
      // 3rd call: the next keyset page — empty, converged
      .mockReturnValueOnce([{ rows: [] }]);

    const r = runDormantAssistantThreadMirrorBackfill();
    expect(r).toEqual({ scanned: 1, backfilled: 1, failed: 0 });

    const mirrorCall = runPostgresQueriesSync.mock.calls[1][0] as {
      queries: Array<{ text: string; values: unknown[] }>;
      transaction?: boolean;
    };
    expect(mirrorCall.transaction).toBe(true);
    // Thread upsert first (FK parent), with the payload-derived fields and a
    // NULL org anchor (boot has no session org; team policy handled inside
    // the shared resolver).
    expect(mirrorCall.queries[0].text).toContain('"assistant_threads"');
    expect(mirrorCall.queries[0].values).toEqual([
      "th-1",
      "user-7",
      null,
      "Dormant thread",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
    // Reconcile DELETE + namespaced turn INSERT follow.
    expect(mirrorCall.queries[1].text).toContain("DELETE FROM");
    expect(mirrorCall.queries[2].values[1]).toEqual([
      buildLegacyMirrorTurnId("th-1", "m1"),
      buildLegacyMirrorTurnId("th-1", "m2"),
    ]);
  });

  it("keeps team-owned dormant threads on the NULL org anchor (P2b policy)", () => {
    const payload = { teamId: "team-3", title: "Team thread", messages: [] };
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [dormantRow("th-t", payload)] }])
      .mockReturnValueOnce([{ rows: [] }, { rows: [] }])
      .mockReturnValueOnce([{ rows: [] }]);
    const r = runDormantAssistantThreadMirrorBackfill();
    expect(r.backfilled).toBe(1);
    const mirrorCall = runPostgresQueriesSync.mock.calls[1][0] as {
      queries: Array<{ values: unknown[] }>;
    };
    expect(mirrorCall.queries[0].values[2]).toBeNull();
  });

  it("soft-fails a row and keeps paginating (keyset progress past failures)", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([
        { rows: [dormantRow("th-bad", { messages: [] }), dormantRow("th-good", { messages: [] })] },
      ])
      .mockImplementationOnce(() => {
        throw new Error("row exploded");
      })
      .mockReturnValueOnce([{ rows: [] }, { rows: [] }])
      .mockReturnValueOnce([{ rows: [] }]);
    const log = vi.fn();
    const r = runDormantAssistantThreadMirrorBackfill({ log });
    expect(r).toEqual({ scanned: 2, backfilled: 1, failed: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("th-bad"));
    // The keyset cursor advanced to the LAST row of the batch regardless.
    const secondPage = runPostgresQueriesSync.mock.calls[3][0] as {
      queries: Array<{ values: unknown[] }>;
    };
    expect(secondPage.queries[0].values[0]).toBe("th-good");
  });

  it("honors the kill switch", () => {
    process.env.CINATRA_ASSISTANT_THREAD_BACKFILL = "off";
    const r = runDormantAssistantThreadMirrorBackfill();
    expect(r.skippedReason).toContain("disabled");
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });
});
