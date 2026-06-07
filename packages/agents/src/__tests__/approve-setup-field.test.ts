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
 *  1. "setup-{runId}" synthetic path — validates run, merges inputParams,
 *     transitions to "queued", enqueues AGENT_BUILDER_EXECUTION.
 *  2. Real UUID path — throws with clear error message.
 *
 *   pnpm --filter @cinatra/agent-builder exec vitest run \
 *     src/__tests__/approve-setup-field.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — captures Drizzle update calls for assertion
// ---------------------------------------------------------------------------
const dbWrites: Array<{ op: string; table: string; set: any }> = [];

const dbMock = vi.hoisted(() => {
  const update = vi.fn((_table: any) => ({
    set: vi.fn((payload: any) => ({
      where: vi.fn(async () => {
        dbWrites.push({ op: "update", table: "agent_runs", set: payload });
      }),
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

// ---------------------------------------------------------------------------
// 1. "setup-{runId}" synthetic path (setup interrupt loop)
// ---------------------------------------------------------------------------
describe("approveReviewTaskInternal — setup-* synthetic path (110-G)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWrites.length = 0;
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
describe("approveReviewTaskInternal — real UUID path removed (110-G)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
describe("approveReviewTaskInternal — wayflow-* sourceType guard (WR-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
