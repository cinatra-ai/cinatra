/**
 * Unit tests for approveReviewTaskInternal.
 *
 * Current review-task approval behavior:
 *  - Real UUID reviewTaskId paths are removed — they throw.
 *  - Setup interrupt approval uses synthetic "setup-{runId}" IDs.
 *
 * Only the setup-* path and the real-UUID throw remain.
 *
 * Test structure:
 *  1. "setup-{runId}" synthetic path — validates run, then merges inputParams
 *     AND transitions to "queued" in ONE atomic CAS UPDATE pinned to
 *     status = 'pending_approval' (#76 regression), enqueues
 *     AGENT_BUILDER_EXECUTION only after the write resolves with one row.
 *  2. Real UUID path — throws with clear error message.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/approve-setup-field.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — captures Drizzle update calls for assertion
// ---------------------------------------------------------------------------
const dbWrites: Array<{ op: string; table: string; set: any; where: any }> = [];

// Failure injection for the #76 regression tests:
//  - `rejectNextUpdate`: the next UPDATE rejects BEFORE recording the write —
//    modeling a statement that never committed (Postgres single-statement
//    atomicity).
//  - `staleNextUpdate`: the next UPDATE resolves with ZERO rows — modeling the
//    CAS losing a race (the run left pending_approval between the early read
//    and the write), again without recording a write.
const dbFail = vi.hoisted(() => ({ rejectNextUpdate: false, staleNextUpdate: false }));

const dbMock = vi.hoisted(() => {
  const update = vi.fn((_table: any) => ({
    set: vi.fn((payload: any) => ({
      where: vi.fn((condition: any) => ({
        returning: vi.fn(async () => {
          if (dbFail.rejectNextUpdate) {
            dbFail.rejectNextUpdate = false;
            throw new Error("__db_write_failed__");
          }
          if (dbFail.staleNextUpdate) {
            dbFail.staleNextUpdate = false;
            return [];
          }
          dbWrites.push({ op: "update", table: "agent_runs", set: payload, where: condition });
          return [{ id: "updated-row" }];
        }),
      })),
    })),
  }));
  return { update };
});
vi.mock("../db", () => ({
  db: dbMock,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

const bgJobs = vi.hoisted(() => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: {
    AGENT_BUILDER_EXECUTION: "agent-builder-execution",
  },
}));
vi.mock("@/lib/background-jobs", () => bgJobs);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  // writeHitlPrompt is invoked on the wayflow happy path
  // (post-sourceType guard, pre-sendTask). Stubbed so the
  // sourceType-guard happy-path test reaches a meaningful downstream failure
  // (sendTask), not a TypeError from a missing mock.
  writeHitlPrompt: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

// wayflow path mocks. The sourceType guard runs BEFORE resolveWayflowUrl /
// sendTask, so these are stubbed only to avoid bare-import failures in tests
// that do reach the wayflow branch.
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
}));

import { approveReviewTaskInternal } from "../review-task-actions";

// Circular-safe stringify for inspecting Drizzle SQL condition trees (they
// reference table/column objects with back-references). Used to pin the
// CAS shape of the approval UPDATE's WHERE clause.
function sqlConditionToString(condition: unknown): string {
  const seen = new Set<object>();
  return JSON.stringify(condition, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// 1. "setup-{runId}" synthetic path (setup interrupt loop)
// ---------------------------------------------------------------------------
describe("approveReviewTaskInternal — setup-* synthetic path", () => {
  beforeEach(() => {
    // resetAllMocks (NOT clearAllMocks): clearAllMocks keeps queued
    // mockResolvedValue implementations, so e.g. a readAgentTemplateById
    // programmed in one test would leak into later tests. resetAllMocks
    // restores every mock to its creation-time implementation.
    vi.resetAllMocks();
    dbWrites.length = 0;
    dbFail.rejectNextUpdate = false;
    dbFail.staleNextUpdate = false;
  });

  it("merges single-field value into inputParams and re-enqueues AGENT_BUILDER_EXECUTION", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s1",
      templateId: "tpl-s1",
      status: "pending_approval",
      inputParams: { existingKey: "val" },
    });

    await approveReviewTaskInternal(
      "setup-run-s1",
      "actor-1",
      { name: "Alice" },
      "name",
    );

    // inputParams updated via JSONB merge.
    const inputParamsWrite = dbWrites.find((w) => w.set?.inputParams !== undefined);
    expect(inputParamsWrite).toBeDefined();

    // Status transitioned back to "queued".
    const statusWrite = dbWrites.find((w) => w.set?.status === "queued");
    expect(statusWrite).toBeDefined();

    // Re-enqueued for setup loop to re-evaluate remaining fields.
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledWith(
      "agent-builder-execution",
      { runId: "run-s1" },
      { jobId: "resume-setup-run-s1" },
    );
  });

  // Regression: assert the SQL fragment serializes only values[fieldName],
  // NOT the whole values object. The single-field path must not serialize the
  // whole `{ url: "..." }` object and then wrap it again via
  // jsonb_build_object(fieldName, ...), producing
  // `inputParams = { url: { url: "..." } }` (double-wrap). Double-wrapping
  // makes WayFlow re-emit the same setup gate forever because url is a JSON
  // object, not the expected string.
  it("REGRESSION: single-field path serializes values[fieldName] only (no double-wrap)", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s1b",
      templateId: "tpl-s1b",
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal(
      "setup-run-s1b",
      "actor-1",
      { url: "https://example.com" },
      "url",
    );

    const inputParamsWrite = dbWrites.find((w) => w.set?.inputParams !== undefined);
    expect(inputParamsWrite).toBeDefined();
    // Drizzle sql template object exposes queryChunks: literal strings interleaved
    // with interpolated values. The serialized JSON for the field value appears
    // as a string in the chunks. We want '"https://example.com"' (the UNWRAPPED
    // value), not '{"url":"https://example.com"}' (the double-wrap).
    const chunks = (inputParamsWrite!.set.inputParams as { queryChunks?: unknown[] }).queryChunks;
    expect(chunks).toBeDefined();
    const stringChunks = (chunks as unknown[]).filter(
      (c): c is string => typeof c === "string",
    );
    expect(stringChunks).toContain('"https://example.com"');
    expect(stringChunks).not.toContain('{"url":"https://example.com"}');
  });

  // ---------------------------------------------------------------------------
  // #76 regression: the inputParams merge and the pending_approval -> queued
  // status flip used to be two sequential UPDATE statements; a crash between
  // them left the run with merged inputParams but a stale pending_approval
  // status. The fix combines both into ONE CAS UPDATE on the agent_runs row
  // (WHERE id = runId AND status = 'pending_approval') — Postgres
  // single-statement atomicity means there is no partial-state window at all,
  // and the status guard means a concurrent reject/stop/fail can't be
  // clobbered back to "queued". These tests pin (a) the single-statement
  // shape, (b) that a failed write commits nothing and never enqueues the
  // resume job, (c) the CAS WHERE shape, and (d) that a lost CAS race throws
  // and never enqueues.
  // ---------------------------------------------------------------------------
  it("REGRESSION (#76): single-field approval issues exactly ONE UPDATE carrying both inputParams merge and status flip", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-a1",
      templateId: "tpl-a1",
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal("setup-run-a1", "actor-1", { name: "Alice" }, "name");

    // Exactly one statement hit the DB...
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbWrites).toHaveLength(1);
    // ...and it carries BOTH effects in the same .set payload.
    expect(dbWrites[0].set.inputParams).toBeDefined();
    expect(dbWrites[0].set.status).toBe("queued");
  });

  it("REGRESSION (#76): grouped-form approval issues exactly ONE UPDATE carrying both inputParams merge and status flip", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-a2",
      templateId: "tpl-a2",
      status: "pending_approval",
      inputParams: {},
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-a2",
      inputSchema: { properties: { website: {}, senderEmail: {} } },
    });

    await approveReviewTaskInternal("setup-run-a2", "actor-1", {
      website: "https://ex.com",
      senderEmail: "a@b.com",
    });

    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbWrites).toHaveLength(1);
    expect(dbWrites[0].set.inputParams).toBeDefined();
    expect(dbWrites[0].set.status).toBe("queued");
  });

  it("REGRESSION (#76): a mid-write failure commits nothing — no partial state, no resume job enqueued", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-a3",
      templateId: "tpl-a3",
      status: "pending_approval",
      inputParams: {},
    });

    dbFail.rejectNextUpdate = true;
    await expect(
      approveReviewTaskInternal("setup-run-a3", "actor-1", { name: "Alice" }, "name"),
    ).rejects.toThrow(/__db_write_failed__/);

    // The single statement failed atomically: neither the inputParams merge
    // nor the status flip was committed...
    expect(dbWrites).toHaveLength(0);
    // ...and only one statement was ever attempted (nothing committed before
    // the failing write either).
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    // Redis enqueue must only fire after the DB commit succeeds.
    expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("REGRESSION (#76): the approval UPDATE is CAS-shaped — WHERE pins id AND status = 'pending_approval'", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-a4",
      templateId: "tpl-a4",
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal("setup-run-a4", "actor-1", { name: "Alice" }, "name");

    expect(dbWrites).toHaveLength(1);
    const whereStr = sqlConditionToString(dbWrites[0].where);
    // Both CAS conditions must be bound into the WHERE clause: the row id...
    expect(whereStr).toContain("run-a4");
    // ...and the expected-status guard. Without it, a concurrent
    // reject/stop/fail landing between the early read and this write would be
    // silently clobbered back to "queued".
    expect(whereStr).toContain("pending_approval");
  });

  it("REGRESSION (#76): CAS loses to a concurrent transition — zero rows updated throws stale, nothing enqueued", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-a5",
      templateId: "tpl-a5",
      status: "pending_approval", // early read still sees pending_approval...
      inputParams: {},
    });

    // ...but by write time another path has transitioned the run, so the CAS
    // UPDATE matches zero rows.
    dbFail.staleNextUpdate = true;
    await expect(
      approveReviewTaskInternal("setup-run-a5", "actor-1", { name: "Alice" }, "name"),
    ).rejects.toThrow(/left pending_approval before the approval committed/);

    // Nothing was committed and the resume job must NOT be enqueued — the
    // concurrent transition (e.g. reject -> failed) owns the run now.
    expect(dbWrites).toHaveLength(0);
    expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("merges grouped-form values (no fieldName) via JSONB object spread", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s2",
      templateId: "tpl-s2",
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal("setup-run-s2", "actor-1", {
      website: "https://ex.com",
      senderEmail: "a@b.com",
    });

    const inputParamsWrite = dbWrites.find((w) => w.set?.inputParams !== undefined);
    expect(inputParamsWrite).toBeDefined();

    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledWith(
      "agent-builder-execution",
      { runId: "run-s2" },
      { jobId: "resume-setup-run-s2" },
    );
  });

  it("throws when run not found", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);

    await expect(
      approveReviewTaskInternal("setup-run-missing", "actor-1", { x: 1 }),
    ).rejects.toThrow(/run run-missing not found/);
  });

  it("throws when run is not pending_approval (stale approval guard)", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s3",
      status: "completed",
      inputParams: {},
    });

    await expect(
      approveReviewTaskInternal("setup-run-s3", "actor-1", { x: 1 }),
    ).rejects.toThrow(/not pending_approval/);
  });

  it("throws when fieldName is provided but absent from values (single-field path guard)", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s4",
      status: "pending_approval",
      inputParams: {},
    });

    await expect(
      approveReviewTaskInternal(
        "setup-run-s4",
        "actor-1",
        { other: "val" }, // does not contain fieldName "name"
        "name",
      ),
    ).rejects.toThrow(/fieldName "name" is not present/);
  });

  it("throws when values payload exceeds 65536 bytes", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s5",
      status: "pending_approval",
      inputParams: {},
    });

    const oversized = { data: "x".repeat(70_000) };
    await expect(
      approveReviewTaskInternal("setup-run-s5", "actor-1", oversized),
    ).rejects.toThrow(/values payload too large/);

    expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("skips inputParams update when values is undefined", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-s6",
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal("setup-run-s6", "actor-1", undefined);

    const inputParamsWrite = dbWrites.find((w) => w.set?.inputParams !== undefined);
    expect(inputParamsWrite).toBeUndefined();

    // Status update + re-enqueue still happen.
    const statusWrite = dbWrites.find((w) => w.set?.status === "queued");
    expect(statusWrite).toBeDefined();
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledWith(
      "agent-builder-execution",
      { runId: "run-s6" },
      { jobId: "resume-setup-run-s6" },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Real UUID path — unsupported because setup interrupt approval uses synthetic IDs
// ---------------------------------------------------------------------------
describe("approveReviewTaskInternal — real UUID path removed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws a clear error for any real UUID reviewTaskId (no DB row lookup attempted)", async () => {
    await expect(
      approveReviewTaskInternal("rt-some-real-uuid", "actor-1", { x: 1 }),
    ).rejects.toThrow(/real UUID paths are not supported/);
  });
});

// ---------------------------------------------------------------------------
// 3. wayflow- path — sourceType invariant
// ---------------------------------------------------------------------------
describe("approveReviewTaskInternal — wayflow-* sourceType guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbWrites.length = 0;
  });

  it("throws when template.sourceType is not 'internal'", async () => {
    storeMock.readAgentRunByTaskId.mockResolvedValue({
      id: "run-w1",
      templateId: "tpl-external",
      status: "pending_approval",
      a2aContextId: "ctx-w1",
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-external",
      packageName: "@cinatra-ai/email-outreach-agent",
      sourceType: "external",
    });

    await expect(
      approveReviewTaskInternal("wayflow-task-w1", "actor-1", undefined),
    ).rejects.toThrow(
      /WayFlow path requires internal template; got sourceType=external/,
    );
  });

  it("does NOT throw the sourceType guard when sourceType is 'internal' (proceeds past the guard)", async () => {
    // Once the guard passes, downstream code (resolveWayflowUrl → sendTask) runs.
    // Make resolveWayflowUrl throw a sentinel so the test fails fast at the
    // next step without needing to mock the WayFlow A2A client / network. The
    // assertion checks the thrown message is NOT the sourceType guard error,
    // proving the guard let an internal-sourced template through.
    const { resolveWayflowUrl } = await import("../wayflow-url");
    (resolveWayflowUrl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("__test_sentinel__: resolveWayflowUrl reached");
    });
    storeMock.readAgentRunByTaskId.mockResolvedValue({
      id: "run-w2",
      templateId: "tpl-internal",
      status: "pending_approval",
      a2aContextId: "ctx-w2",
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tpl-internal",
      packageName: "@cinatra-ai/email-outreach-agent",
      sourceType: "internal",
    });

    await expect(
      approveReviewTaskInternal("wayflow-task-w2", "actor-1", undefined),
    ).rejects.toThrow(/__test_sentinel__/);
    // And explicitly NOT the sourceType guard error.
    await expect(
      (async () => {
        (resolveWayflowUrl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
          throw new Error("__test_sentinel__: resolveWayflowUrl reached");
        });
        return approveReviewTaskInternal("wayflow-task-w2", "actor-1", undefined);
      })(),
    ).rejects.not.toThrow(/WayFlow path requires internal template/);
  });
});
