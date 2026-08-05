/**
 * Chunked inline fan-out unit tests (cinatra #1365 / S7, acceptance criterion 3).
 *
 * Proves a >200-pair inline event evaluates EVERY pair via continuation jobs
 * instead of silently dropping the remainder at the 200 cap, and that the
 * frozen candidate set makes the fan-out immune to catalog churn mid-run (no
 * skipped or duplicated pairs).
 *
 * Setup-flow S6: the externally-enqueued job is a SEED that mints the frozen
 * run context + candidate set and hands off to a fully-frozen eval job
 * without evaluating anything itself — so a BullMQ retry can never split one
 * logical fan-out across two contexts (regression tests below).
 *
 * `evaluatePair` and the background-job queue are mocked so the fan-out logic
 * is exercised without an LLM or BullMQ; continuation jobs are "run" by feeding
 * the captured enqueue payload back into the handler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the vi.mock factories (which are lifted above the imports) can
// reference these fns without a temporal-dead-zone error.
const { evaluatePair, enqueueBackgroundJob } = vi.hoisted(() => ({
  evaluatePair: vi.fn().mockResolvedValue({ skipped: false }),
  enqueueBackgroundJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../evaluate-pair", () => ({ evaluatePair }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob,
  ensureBackgroundJobRuntime: vi.fn(),
  BACKGROUND_JOB_NAMES: {
    SKILL_MATCH_INLINE_FOR_SKILL: "skill-match-inline-for-skill",
    SKILL_MATCH_INLINE_FOR_AGENT: "skill-match-inline-for-agent",
  },
}));

import { handleInlineForSkill } from "../jobs";
import { SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT } from "../constants";
import type { CatalogAgent, CatalogProvider, CatalogSkill } from "../types";

const CAP = SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT;

function agent(i: number): CatalogAgent {
  const id = `@cinatra/agent-${String(i).padStart(4, "0")}`;
  return { packageId: id, packageName: id, humanReadableName: id, description: "d", keywords: [] };
}
const SKILL: CatalogSkill = { id: "skill-x", name: "Skill X", level: "third-party", content: "# X\nc\n" };

function catalogWith(agentsRef: { current: CatalogAgent[] }): CatalogProvider {
  return {
    readAgents: async () => agentsRef.current,
    listSkills: async () => [SKILL],
    getSkillById: async (id) => (id === SKILL.id ? SKILL : null),
  };
}

/** Run the whole fan-out chain by feeding each captured continuation back in. */
async function runChain(catalog: CatalogProvider, seed: { skillId: string; jobStartedAt: string }) {
  await handleInlineForSkill(seed, { catalog });
  // Drain continuations enqueued during processing (FIFO).
  let guard = 0;
  while (enqueueBackgroundJob.mock.calls.length > 0 && guard < 1000) {
    const pending = enqueueBackgroundJob.mock.calls.map((c) => c[1]);
    enqueueBackgroundJob.mockClear();
    for (const data of pending) {
      await handleInlineForSkill(data as never, { catalog });
    }
    guard += 1;
  }
}

describe("handleInlineForSkill chunked fan-out", () => {
  beforeEach(() => {
    evaluatePair.mockClear();
    enqueueBackgroundJob.mockClear();
  });

  it("AC3: a >200-agent event evaluates every pair across continuations", async () => {
    const total = CAP * 2 + 50; // 450 with the default cap of 200
    const agentsRef = { current: Array.from({ length: total }, (_, i) => agent(i)) };
    await runChain(catalogWith(agentsRef), { skillId: SKILL.id, jobStartedAt: new Date("2026-05-12T00:00:00Z").toISOString() });

    // Every pair evaluated exactly once, no dup, no skip.
    expect(evaluatePair).toHaveBeenCalledTimes(total);
    const processed = new Set(evaluatePair.mock.calls.map((c) => (c[0] as { agent: { packageId: string } }).agent.packageId));
    expect(processed.size).toBe(total);
  });

  it("carries one frozen jobStartedAt across the whole fan-out", async () => {
    const jobStartedAt = new Date("2026-05-12T00:00:00Z").toISOString();
    const agentsRef = { current: Array.from({ length: CAP + 10 }, (_, i) => agent(i)) };
    await runChain(catalogWith(agentsRef), { skillId: SKILL.id, jobStartedAt });
    const anchors = new Set(
      evaluatePair.mock.calls.map((c) => (c[1] as { jobStartedAt: Date }).jobStartedAt.toISOString()),
    );
    expect(anchors).toEqual(new Set([jobStartedAt]));
  });

  it("the seed hands off a fully-frozen eval job; the eval job enqueues a continuation with the frozen candidateIds and a run-nonce + offset jobId", async () => {
    const jobStartedAt = new Date("2026-05-12T00:00:00Z").toISOString();
    const agentsRef = { current: Array.from({ length: CAP + 5 }, (_, i) => agent(i)) };
    const catalog = catalogWith(agentsRef);

    // Seed: mints + freezes, evaluates NOTHING, enqueues the off0 eval job.
    await handleInlineForSkill({ skillId: SKILL.id, jobStartedAt }, { catalog });
    expect(evaluatePair).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const [, seedData, seedOpts] = enqueueBackgroundJob.mock.calls[0];
    expect((seedData as { offset: number }).offset).toBe(0);
    expect((seedData as { candidateIds: string[] }).candidateIds).toHaveLength(CAP + 5);
    expect(seedData).toHaveProperty("runContext");
    expect((seedOpts as { jobId: string }).jobId).toContain("-off0");
    enqueueBackgroundJob.mockClear();

    // The off0 eval job processes its window and chains the continuation.
    await handleInlineForSkill(seedData as never, { catalog });
    expect(evaluatePair).toHaveBeenCalledTimes(CAP);
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const [, data, opts] = enqueueBackgroundJob.mock.calls[0];
    expect((data as { offset: number }).offset).toBe(CAP);
    expect((data as { candidateIds: string[] }).candidateIds).toHaveLength(CAP + 5);
    // jobId carries BOTH a unique per-run nonce and the offset, so two
    // concurrent same-skill runs cannot coalesce and drop a chunk.
    const runNonce = (data as { runNonce: string }).runNonce;
    expect(typeof runNonce).toBe("string");
    expect(runNonce.length).toBeGreaterThan(0);
    expect((opts as { jobId: string }).jobId).toContain(`-${runNonce}-off${CAP}`);
  });

  it("mints a distinct run nonce per fan-out (no cross-run jobId collision)", async () => {
    const jobStartedAt = new Date("2026-05-12T00:00:00Z").toISOString();
    const agentsRef = { current: Array.from({ length: CAP + 1 }, (_, i) => agent(i)) };
    const seed = { skillId: SKILL.id, jobStartedAt };
    // Two independent first-invocations for the SAME skill and identical
    // jobStartedAt: the continuation jobIds must still differ.
    await handleInlineForSkill(seed, { catalog: catalogWith(agentsRef) });
    await handleInlineForSkill(seed, { catalog: catalogWith(agentsRef) });
    const jobIds = enqueueBackgroundJob.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(jobIds).toHaveLength(2);
    expect(jobIds[0]).not.toBe(jobIds[1]);
  });

  it("de-duplicates candidate ids so a repeated agent is evaluated once", async () => {
    const dup = agent(1);
    const agentsRef = { current: [agent(0), dup, dup, agent(2)] };
    await runChain(catalogWith(agentsRef), { skillId: SKILL.id, jobStartedAt: new Date("2026-05-12T00:00:00Z").toISOString() });
    const processed = evaluatePair.mock.calls.map((c) => (c[0] as { agent: { packageId: string } }).agent.packageId);
    expect(processed.filter((id) => id === dup.packageId)).toHaveLength(1);
    expect(new Set(processed).size).toBe(3);
  });

  it("frozen set: agents installed mid-run are not processed and cause no duplicate/skip", async () => {
    const total = CAP + 20;
    const agentsRef = { current: Array.from({ length: total }, (_, i) => agent(i)) };
    const originalIds = new Set(agentsRef.current.map((a) => a.packageId));
    const catalog = catalogWith(agentsRef);

    // Seed freezes the candidate set and hands off the off0 eval job.
    await handleInlineForSkill(
      { skillId: SKILL.id, jobStartedAt: new Date("2026-05-12T00:00:00Z").toISOString() },
      { catalog },
    );
    const off0 = enqueueBackgroundJob.mock.calls[0][1];
    enqueueBackgroundJob.mockClear();

    // First window (offset 0) processes CAP agents and enqueues a continuation.
    await handleInlineForSkill(off0 as never, { catalog });
    const continuation = enqueueBackgroundJob.mock.calls[0][1] as { candidateIds: string[] };
    enqueueBackgroundJob.mockClear();

    // Mutate the catalog: add 100 brand-new agents before the continuation runs.
    for (let i = 0; i < 100; i += 1) agentsRef.current.push(agent(10000 + i));

    // Run the continuation — it uses the FROZEN candidateIds, not the mutated catalog.
    await handleInlineForSkill(continuation as never, { catalog });

    const processed = new Set(evaluatePair.mock.calls.map((c) => (c[0] as { agent: { packageId: string } }).agent.packageId));
    // Exactly the original set — none of the 100 late arrivals, no duplicates.
    expect(processed.size).toBe(total);
    for (const id of processed) expect(originalIds.has(id)).toBe(true);
  });

  it("frozen context across retries: an eval-job retry keeps its payload context even after the configured default changes; a seed retry re-mints uniformly", async () => {
    const jobStartedAt = new Date("2026-05-12T00:00:00Z").toISOString();
    const agentsRef = { current: Array.from({ length: 3 }, (_, i) => agent(i)) };
    const catalog = catalogWith(agentsRef);
    const contextA = { provider: "openai", model: "model-a", evaluatorVersion: "llm-matcher-v2" };
    const contextB = { provider: "anthropic", model: "model-b", evaluatorVersion: "llm-matcher-v2" };

    // Seed under default A → the handed-off eval payload freezes A.
    await handleInlineForSkill(
      { skillId: SKILL.id, jobStartedAt },
      { catalog, mintRunContext: async () => contextA },
    );
    const off0 = enqueueBackgroundJob.mock.calls[0][1] as { runContext: unknown };
    expect(off0.runContext).toEqual(contextA);
    enqueueBackgroundJob.mockClear();

    // Default changes to B; the eval job (and any BullMQ RETRY of it, which
    // replays the same payload) still evaluates under FROZEN A — the mint
    // seam is never consulted on an eval job.
    await handleInlineForSkill(off0 as never, {
      catalog,
      mintRunContext: async () => contextB,
    });
    for (const call of evaluatePair.mock.calls) {
      expect((call[1] as { runContext: unknown }).runContext).toEqual(contextA);
    }

    // A SEED retry (payload still has no runContext) re-mints — under B — and
    // hands off a uniformly-B run: no evaluation ever ran under two contexts.
    enqueueBackgroundJob.mockClear();
    evaluatePair.mockClear();
    await handleInlineForSkill(
      { skillId: SKILL.id, jobStartedAt },
      { catalog, mintRunContext: async () => contextB },
    );
    expect(evaluatePair).not.toHaveBeenCalled();
    const retriedSeedPayload = enqueueBackgroundJob.mock.calls[0][1] as { runContext: unknown };
    expect(retriedSeedPayload.runContext).toEqual(contextB);
  });
});
