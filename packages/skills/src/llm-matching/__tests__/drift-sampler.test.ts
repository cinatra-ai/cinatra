/**
 * Production drift sampler unit tests.
 *
 * Drives `handleDriftSample` with inline mocks for:
 *   - `deps.readRandomLlmOkMatches` — the store reader
 *   - `deps.evaluate`               — the LLM evaluator (`evaluatePair`)
 *   - `deps.catalog`                — the CatalogProvider seam
 *
 * No real DB, no real LLM. These tests verify the structural contract
 * (5 sampled → 5 evaluated → 5 diffs) and drift-event emission.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the store so the production sampler default doesn't reach Postgres.
vi.mock("../skill-matches-store", () => ({
  readRandomLlmOkMatches: vi.fn().mockResolvedValue([]),
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  readAllMatched: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import { handleDriftSample } from "../drift-sampler";
import {
  SKILL_MATCH_DRIFT_SAMPLE_SIZE,
  LLM_MATCHER_VERSION,
} from "../constants";
import type {
  CatalogAgent,
  CatalogProvider,
  CatalogSkill,
  SkillMatchRow,
} from "../types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-12T03:00:00Z");

function buildAgent(i: number): CatalogAgent {
  return {
    packageId: `@cinatra/agent-${i}`,
    packageName: `@cinatra/agent-${i}`,
    humanReadableName: `Agent ${i}`,
    description: `Description for agent ${i}`,
    keywords: ["x", "y"],
  };
}

function buildSkill(i: number): CatalogSkill {
  return {
    id: `skill-${i}`,
    name: `Skill ${i}`,
    level: "third-party",
    content: `# Skill ${i}\nSome content.\n`,
  };
}

function buildSkillMatchRow(opts: {
  i: number;
  matched: boolean;
  score: number;
  source?: "rule" | "llm" | "manual";
  status?: "ok" | "error" | "skipped";
  evaluatorVersion?: string;
}): SkillMatchRow {
  return {
    agentId: `@cinatra/agent-${opts.i}`,
    skillId: `skill-${opts.i}`,
    source: opts.source ?? "llm",
    matched: opts.matched,
    score: opts.score,
    rationale: opts.matched ? "Applicable." : "Not applicable.",
    evaluatorVersion: opts.evaluatorVersion ?? LLM_MATCHER_VERSION,
    agentInputHash: `agent-hash-${opts.i}`,
    skillInputHash: `skill-hash-${opts.i}`,
    status: opts.status ?? "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: NOW,
    jobStartedAt: NOW,
  };
}

function buildCatalog(agents: CatalogAgent[], skills: CatalogSkill[]): CatalogProvider {
  return {
    readAgents: async () => agents,
    listSkills: async () => skills,
    getSkillById: async (id) => skills.find((s) => s.id === id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleDriftSample — production drift sampler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DRIFT-01: queries the store for SKILL_MATCH_DRIFT_SAMPLE_SIZE rows", async () => {
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([]);
    const evaluate = vi.fn();
    await handleDriftSample({
      catalog: buildCatalog([], []),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });
    expect(readRandomLlmOkMatches).toHaveBeenCalledTimes(1);
    expect(readRandomLlmOkMatches).toHaveBeenCalledWith(SKILL_MATCH_DRIFT_SAMPLE_SIZE);
  });

  it("DRIFT-02: 5 rows → 5 evaluator calls → 5 diffs", async () => {
    const sample = Array.from({ length: 5 }, (_, i) =>
      buildSkillMatchRow({ i, matched: true, score: 0.9 }),
    );
    const agents = sample.map((_, i) => buildAgent(i));
    const skills = sample.map((_, i) => buildSkill(i));
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue(sample);
    const evaluate = vi.fn().mockImplementation(({ agent, skill }) =>
      Promise.resolve({
        ok: true,
        row: {
          agentId: agent.packageId,
          skillId: skill.skillId,
          source: "llm" as const,
          matched: true,
          score: 0.9,
          rationale: "still applicable",
          evaluatorVersion: LLM_MATCHER_VERSION,
          agentInputHash: `agent-hash`,
          skillInputHash: `skill-hash`,
          status: "ok" as const,
          errorCode: null,
          errorMessage: null,
        },
      }),
    );

    const result = await handleDriftSample({
      catalog: buildCatalog(agents, skills),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.sampledCount).toBe(5);
    expect(evaluate).toHaveBeenCalledTimes(5);
    expect(result.evaluatedCount).toBe(5);
    expect(result.diffs).toHaveLength(5);
  });

  it("DRIFT-03: diff structure has previous + current + scoreDelta + flags", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.85 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: true,
        score: 0.82, // small change, no flip, below threshold
        rationale: "Still applicable.",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "agent-hash",
        skillInputHash: "skill-hash",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.diffs).toHaveLength(1);
    const diff = result.diffs[0];
    expect(diff.agentId).toBe(previous.agentId);
    expect(diff.skillId).toBe(previous.skillId);
    expect(diff.previous.matched).toBe(true);
    expect(diff.previous.score).toBeCloseTo(0.85, 5);
    expect(diff.previous.evaluatorVersion).toBe(LLM_MATCHER_VERSION);
    expect(diff.current.matched).toBe(true);
    expect(diff.current.score).toBeCloseTo(0.82, 5);
    expect(diff.scoreDelta).toBeCloseTo(0.03, 5);
    expect(diff.decisionFlipped).toBe(false);
    expect(diff.scoreDeltaAboveThreshold).toBe(false);
  });

  it("DRIFT-04: row whose agent has been uninstalled is silently skipped", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.9 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn();

    // Catalog returns NO agents and NO skills — the resolvePair() call
    // returns null and the sampler skips silently.
    const result = await handleDriftSample({
      catalog: buildCatalog([], []),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.sampledCount).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.evaluatedCount).toBe(0);
    expect(result.diffs).toHaveLength(0);
  });

  it("DRIFT-05: empty sample → 0 evaluator calls and 0 diffs (PoC safety)", async () => {
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([]);
    const evaluate = vi.fn();
    const result = await handleDriftSample({
      catalog: buildCatalog([], []),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });
    expect(result.sampledCount).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.diffs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // `skill-match-drift` event emission
  // -------------------------------------------------------------------------

  it("DRIFT-EVENT-01: NO event when previous and current are identical", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.9 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: true,
        score: 0.9,
        rationale: "still applicable",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "h",
        skillInputHash: "h",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.driftCount).toBe(0);
    const driftWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-drift"'),
    );
    expect(driftWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("DRIFT-EVENT-02: NO event when score moves within ±0.30 (below threshold)", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.85 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: true,
        score: 0.65, // delta = 0.20, below threshold 0.30
        rationale: "still applicable",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "h",
        skillInputHash: "h",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.driftCount).toBe(0);
    const driftWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-drift"'),
    );
    expect(driftWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("DRIFT-EVENT-03: emits kind='decision-flip' when matched flipped (false → true)", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: false, score: 0.2 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: true,
        score: 0.21, // small score change but matched flipped
        rationale: "now applicable",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "h",
        skillInputHash: "h",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.driftCount).toBe(1);
    const driftWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-drift"'),
    );
    expect(driftWarnings).toHaveLength(1);
    const payload = JSON.parse(driftWarnings[0][0] as string);
    expect(payload.event).toBe("skill-match-drift");
    expect(payload.kind).toBe("decision-flip");
    expect(payload.agentId).toBe(previous.agentId);
    expect(payload.skillId).toBe(previous.skillId);
    expect(payload.previous.matched).toBe(false);
    expect(payload.current.matched).toBe(true);
    expect(payload.evaluatorVersion).toEqual({
      from: LLM_MATCHER_VERSION,
      to: LLM_MATCHER_VERSION,
    });

    warnSpy.mockRestore();
  });

  it("DRIFT-EVENT-04: emits kind='score-delta' when score moved beyond threshold (no flip)", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.95 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: true,
        score: 0.55, // delta = 0.40 > threshold 0.30
        rationale: "still matched but less confident",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "h",
        skillInputHash: "h",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.driftCount).toBe(1);
    const driftWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-drift"'),
    );
    expect(driftWarnings).toHaveLength(1);
    const payload = JSON.parse(driftWarnings[0][0] as string);
    expect(payload.kind).toBe("score-delta");
    expect(payload.scoreDelta).toBeCloseTo(0.40, 5);
    expect(payload.previous.matched).toBe(true);
    expect(payload.current.matched).toBe(true);

    warnSpy.mockRestore();
  });

  it("DRIFT-EVENT-05: prioritizes kind='decision-flip' when BOTH flip AND score-delta", async () => {
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.95 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: false, // flipped
        score: 0.40, // delta = 0.55 > threshold 0.30
        rationale: "no longer applicable",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "h",
        skillInputHash: "h",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.driftCount).toBe(1);
    const driftWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-drift"'),
    );
    expect(driftWarnings).toHaveLength(1);
    const payload = JSON.parse(driftWarnings[0][0] as string);
    expect(payload.kind).toBe("decision-flip");
    expect(payload.scoreDelta).toBeCloseTo(0.55, 5);

    warnSpy.mockRestore();
  });

  it("DRIFT-EVENT-06: edge — score-delta clearly under threshold does NOT fire (strict >)", async () => {
    // Strict-inequality boundary: a delta of 0.29 sits one threshold-unit below
    // 0.30 and MUST NOT trigger the score-delta event. We deliberately avoid
    // landing exactly on 0.30 because IEEE-754 subtraction (e.g. 0.80 - 0.50)
    // can yield 0.30000000000000004 — strictly greater than 0.30, which would
    // (correctly) fire the event. The implementation uses strict `>`, so any
    // delta strictly less than 0.30 must not fire.
    const previous = buildSkillMatchRow({ i: 0, matched: true, score: 0.50 });
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue([previous]);
    const evaluate = vi.fn().mockResolvedValue({
      ok: true,
      row: {
        agentId: previous.agentId,
        skillId: previous.skillId,
        source: "llm" as const,
        matched: true,
        score: 0.79, // delta = 0.29 — strictly under threshold 0.30
        rationale: "borderline",
        evaluatorVersion: LLM_MATCHER_VERSION,
        agentInputHash: "h",
        skillInputHash: "h",
        status: "ok" as const,
        errorCode: null,
        errorMessage: null,
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0)], [buildSkill(0)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.driftCount).toBe(0);
    const driftWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-drift"'),
    );
    expect(driftWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("DRIFT-06: evaluator throw is caught and skips the row (does not propagate)", async () => {
    const sample = [
      buildSkillMatchRow({ i: 0, matched: true, score: 0.9 }),
      buildSkillMatchRow({ i: 1, matched: true, score: 0.9 }),
    ];
    const readRandomLlmOkMatches = vi.fn().mockResolvedValue(sample);
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error("OpenAI 429 rate limit"))
      .mockResolvedValueOnce({
        ok: true,
        row: {
          agentId: sample[1].agentId,
          skillId: sample[1].skillId,
          source: "llm" as const,
          matched: true,
          score: 0.9,
          rationale: "ok",
          evaluatorVersion: LLM_MATCHER_VERSION,
          agentInputHash: "h",
          skillInputHash: "h",
          status: "ok" as const,
          errorCode: null,
          errorMessage: null,
        },
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleDriftSample({
      catalog: buildCatalog([buildAgent(0), buildAgent(1)], [buildSkill(0), buildSkill(1)]),
      readRandomLlmOkMatches,
      evaluate,
      now: () => NOW,
    });

    expect(result.sampledCount).toBe(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result.evaluatedCount).toBe(1);
    expect(result.diffs).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("drift-sampler evaluation failed"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});
