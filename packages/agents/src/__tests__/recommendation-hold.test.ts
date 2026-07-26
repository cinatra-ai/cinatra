/**
 * cinatra#2067 (epic #2037 C3) — run-start recommendation HOLD/RELEASE decision.
 *
 * The REAL pure policy lattice (`evaluatePolicy`) is exercised; only the DB-bound
 * scorer, org-rule resolve, assigned-set resolve and park store are mocked. Proves:
 *   - a HEADLESS run never parks (never even evaluates) — the S3 engine is untouched;
 *   - a human-present run PARKS by default (recommendation fires for humanPresent);
 *   - policy-forbidden / manifest-skipped / empty-candidate human-present runs
 *     DO NOT park (issue #2067 AC-4 — no row, dispatch normally);
 *   - an already-decided (released) or already-parked run never re-holds;
 *   - release sweeps only a LIVE (parked) park.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recommendSkillsForAgentTask = vi.fn();
const resolveOrgPolicyRule = vi.fn();
const getAssignedSkillIdsForAgent = vi.fn();
const maybeParkCheckpoint = vi.fn();
const sweepParks = vi.fn();
const readContinuationParksForRun = vi.fn();

vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: (...a: unknown[]) => recommendSkillsForAgentTask(...a),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: (...a: unknown[]) => resolveOrgPolicyRule(...a),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: (...a: unknown[]) => getAssignedSkillIdsForAgent(...a),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (...a: unknown[]) => maybeParkCheckpoint(...a),
  sweepParks: (...a: unknown[]) => sweepParks(...a),
  readContinuationParksForRun: (...a: unknown[]) => readContinuationParksForRun(...a),
}));

import {
  maybeHoldRunForRecommendation,
  releaseRecommendationParkForRun,
} from "../recommendation-hold";

function ranked(over: Record<string, unknown> = {}) {
  return {
    skillId: "s1",
    skillRevisionId: "s1@rev1",
    name: "Skill One",
    score: 0.9,
    rank: 1,
    recommended: true,
    scoredFeatures: [],
    ...over,
  };
}

const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  orgId: "org-1",
  humanPresent: true,
  inputParams: { prompt: "write a blog" },
  ...over,
});

const template = (over: Record<string, unknown> = {}) => ({
  packageName: "@vendor/agent",
  lifecycleConfig: null as string | null,
  ...over,
});

beforeEach(() => {
  recommendSkillsForAgentTask.mockReset();
  resolveOrgPolicyRule.mockReset();
  getAssignedSkillIdsForAgent.mockReset();
  maybeParkCheckpoint.mockReset();
  sweepParks.mockReset();
  readContinuationParksForRun.mockReset();
  resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
  getAssignedSkillIdsForAgent.mockResolvedValue(["s1"]);
  readContinuationParksForRun.mockResolvedValue([]);
  recommendSkillsForAgentTask.mockResolvedValue([ranked()]);
  maybeParkCheckpoint.mockResolvedValue({ parked: true, parkId: "park-1", reevaluationIntent: false });
  // The chip-row hold is fenced default-OFF; activate it for the hold tests.
  process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW = "on";
});

afterEach(() => {
  delete process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
});

describe("maybeHoldRunForRecommendation", () => {
  it("fence OFF (default) → never parks (origin/main behaviour unchanged)", async () => {
    delete process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(readContinuationParksForRun).not.toHaveBeenCalled();
  });

  it("a HEADLESS run never parks (never evaluates)", async () => {
    const out = await maybeHoldRunForRecommendation({
      run: run({ humanPresent: false }),
      template: template(),
    });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(readContinuationParksForRun).not.toHaveBeenCalled();
    expect(recommendSkillsForAgentTask).not.toHaveBeenCalled();
  });

  it("a null-presence run (pre-backfill / worker origin) never parks", async () => {
    const out = await maybeHoldRunForRecommendation({
      run: run({ humanPresent: null }),
      template: template(),
    });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });

  it("a human-present run with candidates PARKS by default (recommendation fires)", async () => {
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    if (out.held) expect(out.parkId).toBe("park-1");
    expect(maybeParkCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("org FORBIDDEN → no park (AC-4)", async () => {
    resolveOrgPolicyRule.mockResolvedValue({ bound: "forbidden" });
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });

  it("manifest requestedSkips recommendation → no park (AC-4)", async () => {
    const out = await maybeHoldRunForRecommendation({
      run: run(),
      template: template({ lifecycleConfig: JSON.stringify({ requestedSkips: ["recommendation"] }) }),
    });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });

  it("fired but ZERO candidates → no park (AC-4)", async () => {
    recommendSkillsForAgentTask.mockResolvedValue([]);
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });

  it("an already-parked run never re-holds (idempotent)", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-x", checkpoint: "recommendation", status: "parked" },
    ]);
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });

  it("an already-RELEASED run (post-decision dispatch) never re-holds", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-x", checkpoint: "recommendation", status: "released" },
    ]);
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });
});

describe("releaseRecommendationParkForRun", () => {
  it("sweeps a LIVE (parked) recommendation park", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "parked" },
    ]);
    sweepParks.mockResolvedValue({ released: 1, blocked: 0 });
    const released = await releaseRecommendationParkForRun("run-1");
    expect(released).toBe(true);
    expect(sweepParks).toHaveBeenCalledWith({ releasedParkIds: ["park-1"] });
  });

  it("no-op when the park is already released", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "released" },
    ]);
    const released = await releaseRecommendationParkForRun("run-1");
    expect(released).toBe(false);
    expect(sweepParks).not.toHaveBeenCalled();
  });

  it("no-op when no recommendation park exists", async () => {
    readContinuationParksForRun.mockResolvedValue([]);
    const released = await releaseRecommendationParkForRun("run-1");
    expect(released).toBe(false);
    expect(sweepParks).not.toHaveBeenCalled();
  });
});
