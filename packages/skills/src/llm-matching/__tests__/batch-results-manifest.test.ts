/**
 * Manifest-mapped batch result processing (setup-flow S6).
 *
 * The poll handler maps ended-batch outcomes through the DURABLE submission
 * manifest — never by reconstructing custom-ids from the live catalog — and:
 *
 *   - writes ok/error rows carrying the RUN's frozen provider/model/evaluator
 *     version (a deploy that bumps the evaluator constant mid-batch cannot
 *     mislabel results);
 *   - DISCARDS results whose pair was edited or deleted mid-batch (current
 *     input hash differs from the submit-time hash);
 *   - normalizes per-request canceled/expired/errored outcomes into error rows
 *     with stable codes (both result streams arrive merged via the v2 seam);
 *   - produces the same row shape as the synchronous evaluator for the same
 *     model output (transport/write parity).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { enqueueBackgroundJob, runsStore, matchStore } = vi.hoisted(() => {
  const runs = new Map<string, Record<string, unknown>>();
  return {
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
    matchStore: {
      readSkillMatch: vi.fn().mockResolvedValue(null),
      upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
      readSkillMatchesByAgent: vi.fn(),
      readSkillMatchesBySkill: vi.fn(),
      deleteSkillMatchesForSkill: vi.fn(),
      deleteSkillMatchesForAgent: vi.fn(),
    },
  };
});

vi.mock("../batch-runs-store", () => runsStore);
vi.mock("../skill-matches-store", () => matchStore);
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob,
  BACKGROUND_JOB_NAMES: {
    SKILL_MATCH_INLINE_FOR_SKILL: "skill-match-inline-for-skill",
    SKILL_MATCH_INLINE_FOR_AGENT: "skill-match-inline-for-agent",
    SKILL_MATCH_BATCH_SUBMIT: "skill-match-batch-submit",
    SKILL_MATCH_BATCH_POLL: "skill-match-batch-poll",
  },
}));

import { handleBatchPoll } from "../jobs";
import { evaluatePair } from "../evaluate-pair";
import { adaptAgentForMatching, adaptSkillForMatching } from "../adapters";
import { computeInputHashes } from "../hashes";
import { LLM_MATCHER_VERSION } from "../constants";
import type { CatalogAgent, CatalogProvider, CatalogSkill, SkillMatchRow } from "../types";

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
const SKILL_2: CatalogSkill = {
  id: "skill-2",
  name: "Skill Two",
  level: "third-party",
  content: "# Skill Two\nBody\n",
};

function catalog(agents: CatalogAgent[], skills: CatalogSkill[]): CatalogProvider {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return {
    readAgents: async () => agents,
    listSkills: async () => skills,
    getSkillById: async (id) => byId.get(id) ?? null,
  };
}

function currentHashes(skill: CatalogSkill) {
  return computeInputHashes(
    adaptAgentForMatching(AGENT),
    adaptSkillForMatching({ id: skill.id, name: skill.name, level: skill.level, content: skill.content, agentId: undefined }),
  );
}

function endedState(batchId: string) {
  return {
    batchId,
    status: "ended" as const,
    counts: null,
    endedAt: new Date("2026-08-04T12:00:00Z").toISOString(),
    expiresAt: null,
    errorMessage: null,
  };
}

const RUN_EVALUATOR_VERSION = "llm-matcher-v1"; // deliberately OLDER than the current constant

function seedEndedRun(manifest: Array<Record<string, string>>): string {
  const batchId = "batch-ended";
  runsStore.runs.set(batchId, {
    batchId,
    status: "in_progress",
    provider: "anthropic",
    model: "claude-test-default",
    evaluatorVersion: RUN_EVALUATOR_VERSION,
    manifest,
    processedPairCount: 0,
    pairCount: manifest.length,
    lastPolledAt: null,
  });
  return batchId;
}

beforeEach(() => {
  runsStore.runs.clear();
  matchStore.upsertSkillMatch.mockClear();
  matchStore.readSkillMatch.mockReset();
  matchStore.readSkillMatch.mockResolvedValue(null);
  enqueueBackgroundJob.mockClear();
});

describe("manifest-mapped result processing", () => {
  it("writes rows through the manifest with the RUN's frozen provenance; discards edited/deleted pairs; normalizes canceled/expired/errored", async () => {
    const h1 = currentHashes(SKILL);
    const manifest = [
      // current → applied
      { customId: "cid-ok", agentId: AGENT.packageId, skillId: SKILL.id, ...h1 },
      // skill edited mid-batch (stale submit-time hash) → discarded
      {
        customId: "cid-stale",
        agentId: AGENT.packageId,
        skillId: SKILL_2.id,
        agentInputHash: h1.agentInputHash,
        skillInputHash: "0".repeat(64),
      },
      // skill deleted mid-batch → discarded
      { customId: "cid-gone", agentId: AGENT.packageId, skillId: "skill-deleted", ...h1 },
      // per-request canceled / expired / errored → normalized error rows
      { customId: "cid-canceled", agentId: AGENT.packageId, skillId: SKILL.id, ...h1 },
      { customId: "cid-expired", agentId: AGENT.packageId, skillId: SKILL.id, ...h1 },
      { customId: "cid-errored", agentId: AGENT.packageId, skillId: SKILL.id, ...h1 },
    ];
    const batchId = seedEndedRun(manifest);

    const outcomes = [
      {
        customId: "cid-ok",
        status: "succeeded" as const,
        text: JSON.stringify({ matched: true, score: 0.9, rationale: "Skill One helps with email" }),
        model: "claude-test-default",
        stopReason: "end_turn",
        rawBody: "{}",
      },
      {
        customId: "cid-stale",
        status: "succeeded" as const,
        text: JSON.stringify({ matched: true, score: 0.9, rationale: "stale answer" }),
        model: "claude-test-default",
        stopReason: "end_turn",
        rawBody: "{}",
      },
      {
        customId: "cid-gone",
        status: "succeeded" as const,
        text: JSON.stringify({ matched: true, score: 0.9, rationale: "gone answer" }),
        model: "claude-test-default",
        stopReason: "end_turn",
        rawBody: "{}",
      },
      { customId: "cid-canceled", status: "canceled" as const },
      { customId: "cid-expired", status: "expired" as const },
      {
        customId: "cid-errored",
        status: "errored" as const,
        error: {
          code: "rate_limit" as const,
          message: "Too many requests",
          providerCode: "rate_limit_error",
          providerStatus: 429,
        },
        rawBody: null,
      },
      { customId: "cid-unknown", status: "canceled" as const },
    ];

    await handleBatchPoll(
      { batchId, jobStartedAt: new Date().toISOString() },
      {
        catalog: catalog([AGENT], [SKILL, SKILL_2]),
        batch: {
          retrieveBatchV2: vi.fn().mockResolvedValue(endedState(batchId)),
          downloadBatchOutcomesV2: vi.fn().mockResolvedValue(outcomes),
        },
      },
    );

    const written = matchStore.upsertSkillMatch.mock.calls.map((c) => c[0] as SkillMatchRow);
    // cid-stale, cid-gone, cid-unknown produced NO rows.
    expect(written).toHaveLength(4);

    const ok = written.find((r) => r.status === "ok");
    expect(ok).toBeDefined();
    expect(ok?.matched).toBe(true);
    expect(ok?.score).toBe(0.9);
    // FROZEN provenance from the run record — not the process's current constant.
    expect(ok?.provider).toBe("anthropic");
    expect(ok?.model).toBe("claude-test-default");
    expect(ok?.evaluatorVersion).toBe(RUN_EVALUATOR_VERSION);
    expect(ok?.evaluatorVersion).not.toBe(LLM_MATCHER_VERSION);
    // Hashes come from the manifest (verified current).
    expect(ok?.agentInputHash).toBe(h1.agentInputHash);
    expect(ok?.skillInputHash).toBe(h1.skillInputHash);

    const codes = written.filter((r) => r.status === "error").map((r) => r.errorCode);
    expect(codes).toEqual(
      expect.arrayContaining(["request_canceled", "request_expired", "rate_limit"]),
    );

    // Run status mapped ended → completed and the manifest bulk was shed.
    const run = runsStore.runs.get(batchId) as Record<string, unknown>;
    expect(run.status).toBe("completed");
    expect(run.manifest).toBeNull();
  });

  it("a run without a manifest is unmappable: nothing is written and the run says so", async () => {
    const batchId = "batch-no-manifest";
    runsStore.runs.set(batchId, {
      batchId,
      status: "in_progress",
      provider: "anthropic",
      model: "m",
      evaluatorVersion: RUN_EVALUATOR_VERSION,
      manifest: null,
      processedPairCount: 0,
      pairCount: 1,
      lastPolledAt: null,
    });
    const download = vi.fn();
    await handleBatchPoll(
      { batchId, jobStartedAt: new Date().toISOString() },
      {
        catalog: catalog([AGENT], [SKILL]),
        batch: {
          retrieveBatchV2: vi.fn().mockResolvedValue(endedState(batchId)),
          downloadBatchOutcomesV2: download,
        },
      },
    );
    expect(download).not.toHaveBeenCalled();
    expect(matchStore.upsertSkillMatch).not.toHaveBeenCalled();
    const run = runsStore.runs.get(batchId) as Record<string, unknown>;
    expect(String(run.errorMessage)).toContain("manifest is missing");
  });
});

describe("write parity: batch outcome vs synchronous evaluator on identical model output", () => {
  it("the same model text lands the same persisted decision fields on both paths", async () => {
    const modelText = JSON.stringify({
      matched: true,
      score: 0.75,
      rationale: "Skill One helps the Email Agent with email",
    });
    const runContext = {
      provider: "anthropic",
      model: "claude-test-default",
      evaluatorVersion: LLM_MATCHER_VERSION,
    };

    // ---- Synchronous path (real evaluator, injected generate) ----
    const NOW = new Date("2026-08-04T10:00:00Z");
    await evaluatePair(
      {
        agent: adaptAgentForMatching(AGENT),
        skill: adaptSkillForMatching({
          id: SKILL.id,
          name: SKILL.name,
          level: SKILL.level,
          content: SKILL.content,
          agentId: undefined,
        }),
      },
      {
        now: () => NOW,
        jobStartedAt: NOW,
        runContext,
        generate: (async () => ({ text: modelText })) as never,
      },
    );
    const syncRow = matchStore.upsertSkillMatch.mock.calls[0][0] as SkillMatchRow;
    matchStore.upsertSkillMatch.mockClear();
    matchStore.readSkillMatch.mockResolvedValue(null);

    // ---- Batch path (same text as a succeeded outcome) ----
    const h = currentHashes(SKILL);
    const batchId = "batch-parity";
    runsStore.runs.set(batchId, {
      batchId,
      status: "in_progress",
      provider: runContext.provider,
      model: runContext.model,
      evaluatorVersion: runContext.evaluatorVersion,
      manifest: [{ customId: "cid-p", agentId: AGENT.packageId, skillId: SKILL.id, ...h }],
      processedPairCount: 0,
      pairCount: 1,
      lastPolledAt: null,
    });
    await handleBatchPoll(
      { batchId, jobStartedAt: NOW.toISOString() },
      {
        catalog: catalog([AGENT], [SKILL]),
        batch: {
          retrieveBatchV2: vi.fn().mockResolvedValue(endedState(batchId)),
          downloadBatchOutcomesV2: vi.fn().mockResolvedValue([
            {
              customId: "cid-p",
              status: "succeeded" as const,
              text: modelText,
              model: runContext.model,
              stopReason: "end_turn",
              rawBody: "{}",
            },
          ]),
        },
      },
    );
    const batchRow = matchStore.upsertSkillMatch.mock.calls[0][0] as SkillMatchRow;

    // Identical persisted decision + provenance (timestamps are anchor-driven).
    const strip = (r: SkillMatchRow) => {
      const { evaluatedAt: _e, jobStartedAt: _j, ...rest } = r;
      return rest;
    };
    expect(strip(batchRow)).toEqual(strip(syncRow));
  });
});

describe("terminal write ordering on the ended path", () => {
  it("a download failure leaves the run NON-terminal, re-enqueues a poll, and propagates", async () => {
    const batchId = "batch-dl-fail";
    runsStore.runs.set(batchId, {
      batchId,
      status: "in_progress",
      provider: "anthropic",
      model: "m",
      evaluatorVersion: RUN_EVALUATOR_VERSION,
      manifest: [
        { customId: "c1", agentId: AGENT.packageId, skillId: SKILL.id, ...currentHashes(SKILL) },
      ],
      processedPairCount: 0,
      pairCount: 1,
      lastPolledAt: null,
    });
    await expect(
      handleBatchPoll(
        { batchId, jobStartedAt: new Date().toISOString() },
        {
          catalog: catalog([AGENT], [SKILL]),
          batch: {
            retrieveBatchV2: vi.fn().mockResolvedValue(endedState(batchId)),
            downloadBatchOutcomesV2: vi.fn().mockRejectedValue(new Error("download flake")),
          },
        },
      ),
    ).rejects.toThrow("download flake");

    const run = runsStore.runs.get(batchId) as Record<string, unknown>;
    // NOT completed: the next poll can retry the drain.
    expect(run.status).toBe("in_progress");
    expect(run.manifest).not.toBeNull();
    expect(matchStore.upsertSkillMatch).not.toHaveBeenCalled();
    // Chain kept alive.
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("the terminal 'completed' write lands only AFTER outcomes are applied", async () => {
    const h = currentHashes(SKILL);
    const batchId = "batch-order";
    runsStore.runs.set(batchId, {
      batchId,
      status: "in_progress",
      provider: "anthropic",
      model: "m",
      evaluatorVersion: RUN_EVALUATOR_VERSION,
      manifest: [{ customId: "c1", agentId: AGENT.packageId, skillId: SKILL.id, ...h }],
      processedPairCount: 0,
      pairCount: 1,
      lastPolledAt: null,
    });
    const statusAtUpsert: unknown[] = [];
    matchStore.upsertSkillMatch.mockImplementation(async () => {
      statusAtUpsert.push((runsStore.runs.get(batchId) as Record<string, unknown>).status);
    });
    await handleBatchPoll(
      { batchId, jobStartedAt: new Date().toISOString() },
      {
        catalog: catalog([AGENT], [SKILL]),
        batch: {
          retrieveBatchV2: vi.fn().mockResolvedValue(endedState(batchId)),
          downloadBatchOutcomesV2: vi.fn().mockResolvedValue([
            {
              customId: "c1",
              status: "succeeded" as const,
              text: JSON.stringify({ matched: true, score: 0.5, rationale: "ok" }),
              model: "m",
              stopReason: "end_turn",
              rawBody: "{}",
            },
          ]),
        },
      },
    );
    // Every row write happened while the run was still NON-terminal.
    expect(statusAtUpsert).toEqual(["in_progress"]);
    const run = runsStore.runs.get(batchId) as Record<string, unknown>;
    expect(run.status).toBe("completed");
    expect(run.manifest).toBeNull();
    matchStore.upsertSkillMatch.mockReset();
    matchStore.upsertSkillMatch.mockResolvedValue(undefined);
  });
});
