/**
 * Capability-routed full-catalog runs + frozen run context (setup-flow S6).
 *
 * Exercises `handleBatchSubmit` / `handleBatchPoll` with injected batch seams
 * and an in-memory batch-runs store:
 *
 *   - a batch-capable provider takes the neutral batch-v2 submission path and
 *     persists ONE run row carrying the frozen {provider, model,
 *     evaluatorVersion} + the per-request submission manifest;
 *   - a batch-less provider takes the chunked synchronous fan-out with
 *     progress reporting and cancel-at-chunk-boundary semantics;
 *   - no configured runtime is a CLEAN SKIP (no run row, rule rows intact);
 *   - polling drives the adapter of the RUN's frozen provider, never the live
 *     default — an admin default change mid-run alters nothing in flight.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { evaluatePair, enqueueBackgroundJob, runsStore } = vi.hoisted(() => {
  const runs = new Map<string, Record<string, unknown>>();
  return {
    evaluatePair: vi.fn().mockResolvedValue({ skipped: false }),
    enqueueBackgroundJob: vi.fn().mockResolvedValue(undefined),
    runsStore: {
      runs,
      insertBatchRun: vi.fn(async (row: { batchId: string }) => {
        runs.set(row.batchId, { ...row });
      }),
      updateBatchRun: vi.fn(async (batchId: string, updates: Record<string, unknown>) => {
        const existing = runs.get(batchId);
        if (existing) Object.assign(existing, updates);
      }),
      readBatchRun: vi.fn(async (batchId: string) => runs.get(batchId) ?? null),
      readLatestBatchRun: vi.fn(async () => null),
      readInFlightBatchRuns: vi.fn(async () => []),
    },
  };
});

vi.mock("../evaluate-pair", () => ({ evaluatePair }));
vi.mock("../batch-runs-store", () => runsStore);
vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob,
  BACKGROUND_JOB_NAMES: {
    SKILL_MATCH_INLINE_FOR_SKILL: "skill-match-inline-for-skill",
    SKILL_MATCH_INLINE_FOR_AGENT: "skill-match-inline-for-agent",
    SKILL_MATCH_BATCH_SUBMIT: "skill-match-batch-submit",
    SKILL_MATCH_BATCH_POLL: "skill-match-batch-poll",
  },
}));

import { handleBatchSubmit, handleBatchPoll, cancelBatchRun } from "../jobs";
import {
  LLM_MATCHER_VERSION,
  SKILL_MATCH_SYNC_RUN_PREFIX,
  SKILL_MATCH_SYNC_RUN_CHUNK_SIZE,
} from "../constants";
import type { CatalogAgent, CatalogProvider, CatalogSkill, SkillMatchRunContext } from "../types";

const AGENT: CatalogAgent = {
  packageId: "@cinatra/email-agent",
  packageName: "@cinatra/email-agent",
  humanReadableName: "Email Agent",
  description: "Sends marketing emails",
  keywords: ["email"],
};
const SKILL: CatalogSkill = {
  id: "skill-1",
  name: "Skill One",
  level: "third-party",
  content: "# Skill One\nBody\n",
};

function catalog(agents: CatalogAgent[] = [AGENT], skills: CatalogSkill[] = [SKILL]): CatalogProvider {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return {
    readAgents: async () => agents,
    listSkills: async () => skills,
    getSkillById: async (id) => byId.get(id) ?? null,
  };
}

const ANTHROPIC_CONTEXT: SkillMatchRunContext = {
  provider: "anthropic",
  model: "claude-test-default",
  evaluatorVersion: LLM_MATCHER_VERSION,
};

function batchSeams(overrides: Record<string, unknown> = {}) {
  return {
    probeBatchCapability: vi
      .fn()
      .mockResolvedValue({ provider: "anthropic", batchVersion: 2, cancelSupported: true }),
    submitBatchV2: vi.fn().mockResolvedValue({ batchId: "batch-abc", status: "in_progress" }),
    retrieveBatchV2: vi.fn(),
    downloadBatchOutcomesV2: vi.fn().mockResolvedValue([]),
    cancelBatchV2: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  evaluatePair.mockClear();
  evaluatePair.mockResolvedValue({ skipped: false });
  enqueueBackgroundJob.mockClear();
  runsStore.runs.clear();
  runsStore.insertBatchRun.mockClear();
  runsStore.updateBatchRun.mockClear();
});

describe("handleBatchSubmit — capability routing + frozen run context", () => {
  it("batch-capable provider: neutral submission carries the frozen model; the run row persists context + manifest", async () => {
    const batch = batchSeams();
    await handleBatchSubmit(
      { submittedBy: "admin-1" },
      {
        catalog: catalog(),
        mintRunContext: async () => ANTHROPIC_CONTEXT,
        batch,
      },
    );

    expect(batch.submitBatchV2).toHaveBeenCalledTimes(1);
    const submitted = batch.submitBatchV2.mock.calls[0][0] as {
      provider: string;
      requests: Array<{ customId: string; model: string; outputSchema?: unknown }>;
    };
    expect(submitted.provider).toBe("anthropic");
    expect(submitted.requests).toHaveLength(1);
    expect(submitted.requests[0].model).toBe("claude-test-default");
    expect(submitted.requests[0].outputSchema).toBeDefined();

    const run = runsStore.runs.get("batch-abc") as Record<string, unknown>;
    expect(run).toBeDefined();
    expect(run.provider).toBe("anthropic");
    expect(run.model).toBe("claude-test-default");
    expect(run.evaluatorVersion).toBe(LLM_MATCHER_VERSION);
    const manifest = run.manifest as Array<Record<string, string>>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0].agentId).toBe(AGENT.packageId);
    expect(manifest[0].skillId).toBe(SKILL.id);
    expect(manifest[0].customId).toBe(submitted.requests[0].customId);
    expect(manifest[0].agentInputHash).toMatch(/^[0-9a-f]{64}$/);

    // A poll job for THIS batch id was scheduled.
    const pollCall = enqueueBackgroundJob.mock.calls.find(
      (c) => c[0] === "skill-match-batch-poll",
    );
    expect(pollCall).toBeDefined();
    expect((pollCall?.[1] as { batchId: string }).batchId).toBe("batch-abc");
  });

  it("batch-less provider: a sync- run row is created with progress bookkeeping and a chunk job", async () => {
    const batch = batchSeams({
      probeBatchCapability: vi
        .fn()
        .mockResolvedValue({ provider: "anthropic", batchVersion: null, cancelSupported: false }),
    });
    await handleBatchSubmit(
      { submittedBy: "admin-1" },
      { catalog: catalog(), mintRunContext: async () => ANTHROPIC_CONTEXT, batch },
    );

    expect(batch.submitBatchV2).not.toHaveBeenCalled();
    const [runId] = [...runsStore.runs.keys()];
    expect(runId.startsWith(SKILL_MATCH_SYNC_RUN_PREFIX)).toBe(true);
    const run = runsStore.runs.get(runId) as Record<string, unknown>;
    expect(run.status).toBe("in_progress");
    expect(run.provider).toBe("anthropic");
    expect(run.processedPairCount).toBe(0);
    expect((run.manifest as unknown[]).length).toBe(1);

    const chunkCall = enqueueBackgroundJob.mock.calls.find(
      (c) => c[0] === "skill-match-batch-poll",
    );
    expect((chunkCall?.[1] as { batchId: string }).batchId).toBe(runId);
  });

  it("no configured runtime: clean skip — no run row, no submission, no poll job", async () => {
    const batch = batchSeams();
    await handleBatchSubmit(
      { submittedBy: "admin-1" },
      { catalog: catalog(), mintRunContext: async () => null, batch },
    );
    expect(batch.probeBatchCapability).not.toHaveBeenCalled();
    expect(batch.submitBatchV2).not.toHaveBeenCalled();
    expect(runsStore.runs.size).toBe(0);
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });
});

describe("handleBatchPoll — the frozen provider drives every stage", () => {
  it("polls through the RUN's provider even when the live default has changed", async () => {
    runsStore.runs.set("batch-frozen", {
      batchId: "batch-frozen",
      status: "in_progress",
      provider: "anthropic",
      model: "claude-test-default",
      evaluatorVersion: LLM_MATCHER_VERSION,
      manifest: [],
      processedPairCount: 0,
      pairCount: 0,
      lastPolledAt: null,
    });
    const batch = batchSeams({
      retrieveBatchV2: vi.fn().mockResolvedValue({
        batchId: "batch-frozen",
        status: "in_progress",
        counts: null,
        endedAt: null,
        expiresAt: null,
        errorMessage: null,
      }),
    });

    await handleBatchPoll(
      { batchId: "batch-frozen", jobStartedAt: new Date().toISOString() },
      {
        catalog: catalog(),
        // The live default is now a DIFFERENT provider — the poll must not care.
        mintRunContext: async () => ({
          provider: "openai",
          model: "gpt-4o-mini",
          evaluatorVersion: LLM_MATCHER_VERSION,
        }),
        batch,
      },
    );

    expect(batch.retrieveBatchV2).toHaveBeenCalledWith({
      provider: "anthropic",
      batchId: "batch-frozen",
    });
    // Neutral status mapped onto the persisted vocabulary + re-poll scheduled.
    const run = runsStore.runs.get("batch-frozen") as Record<string, unknown>;
    expect(run.status).toBe("in_progress");
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("maps neutral canceling → persisted cancelling and keeps polling", async () => {
    runsStore.runs.set("batch-c", {
      batchId: "batch-c",
      status: "in_progress",
      provider: "anthropic",
      model: "m",
      evaluatorVersion: LLM_MATCHER_VERSION,
      manifest: [],
      processedPairCount: 0,
      pairCount: 0,
      lastPolledAt: null,
    });
    const batch = batchSeams({
      retrieveBatchV2: vi.fn().mockResolvedValue({
        batchId: "batch-c",
        status: "canceling",
        counts: null,
        endedAt: null,
        expiresAt: null,
        errorMessage: null,
      }),
    });
    await handleBatchPoll(
      { batchId: "batch-c", jobStartedAt: new Date().toISOString() },
      { catalog: catalog(), batch },
    );
    const run = runsStore.runs.get("batch-c") as Record<string, unknown>;
    expect(run.status).toBe("cancelling");
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });
});

describe("synchronous fan-out chunks — progress, frozen context, cancel", () => {
  function seedSyncRun(pairTotal: number): string {
    const runId = `${SKILL_MATCH_SYNC_RUN_PREFIX}test-run`;
    const manifest = Array.from({ length: pairTotal }, (_, i) => ({
      customId: `cid-${i}`,
      agentId: AGENT.packageId,
      skillId: SKILL.id,
      agentInputHash: "a".repeat(64),
      skillInputHash: "b".repeat(64),
    }));
    runsStore.runs.set(runId, {
      batchId: runId,
      status: "in_progress",
      provider: "anthropic",
      model: "claude-test-default",
      evaluatorVersion: LLM_MATCHER_VERSION,
      manifest,
      processedPairCount: 0,
      pairCount: pairTotal,
      lastPolledAt: null,
    });
    return runId;
  }

  it("processes one chunk, records progress, threads the FROZEN context into every evaluation, then chains", async () => {
    const total = SKILL_MATCH_SYNC_RUN_CHUNK_SIZE + 3;
    const runId = seedSyncRun(total);

    await handleBatchPoll(
      { batchId: runId, jobStartedAt: new Date().toISOString() },
      { catalog: catalog(), batch: batchSeams() },
    );

    expect(evaluatePair).toHaveBeenCalledTimes(SKILL_MATCH_SYNC_RUN_CHUNK_SIZE);
    for (const call of evaluatePair.mock.calls) {
      const deps = call[1] as { runContext: SkillMatchRunContext };
      expect(deps.runContext).toEqual(ANTHROPIC_CONTEXT);
    }
    const run = runsStore.runs.get(runId) as Record<string, unknown>;
    expect(run.processedPairCount).toBe(SKILL_MATCH_SYNC_RUN_CHUNK_SIZE);
    expect(run.status).toBe("in_progress");
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);

    // Second chunk completes the run.
    await handleBatchPoll(
      { batchId: runId, jobStartedAt: new Date().toISOString() },
      { catalog: catalog(), batch: batchSeams() },
    );
    const finished = runsStore.runs.get(runId) as Record<string, unknown>;
    expect(finished.status).toBe("completed");
    expect(finished.processedPairCount).toBe(total);
    expect(finished.manifest).toBeNull();
  });

  it("cancel: cancelBatchRun marks cancelling; the next chunk boundary finalizes as cancelled", async () => {
    const runId = seedSyncRun(SKILL_MATCH_SYNC_RUN_CHUNK_SIZE * 2);

    const cancelResult = await cancelBatchRun(runId);
    expect(cancelResult).toEqual({ ok: true, status: "cancelling" });
    expect((runsStore.runs.get(runId) as Record<string, unknown>).status).toBe("cancelling");

    await handleBatchPoll(
      { batchId: runId, jobStartedAt: new Date().toISOString() },
      { catalog: catalog(), batch: batchSeams() },
    );
    const run = runsStore.runs.get(runId) as Record<string, unknown>;
    expect(run.status).toBe("cancelled");
    expect(evaluatePair).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("provider-batch cancel routes through the frozen provider's adapter", async () => {
    runsStore.runs.set("batch-x", {
      batchId: "batch-x",
      status: "in_progress",
      provider: "anthropic",
      model: "m",
      evaluatorVersion: LLM_MATCHER_VERSION,
      manifest: [],
      processedPairCount: 0,
      pairCount: 1,
      lastPolledAt: null,
    });
    const cancelBatchV2 = vi.fn().mockResolvedValue({
      batchId: "batch-x",
      status: "canceling",
      counts: null,
      endedAt: null,
      expiresAt: null,
      errorMessage: null,
    });
    const result = await cancelBatchRun("batch-x", { batch: { cancelBatchV2 } });
    expect(cancelBatchV2).toHaveBeenCalledWith({ provider: "anthropic", batchId: "batch-x" });
    expect(result).toEqual({ ok: true, status: "cancelling" });
  });
});
