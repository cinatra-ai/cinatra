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
const resolveAssignedSkillsActorForRun = vi.fn();

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
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: (...a: unknown[]) => resolveAssignedSkillsActorForRun(...a),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (...a: unknown[]) => maybeParkCheckpoint(...a),
  sweepParks: (...a: unknown[]) => sweepParks(...a),
  readContinuationParksForRun: (...a: unknown[]) => readContinuationParksForRun(...a),
}));

import {
  maybeHoldRunForRecommendation,
  releaseRecommendationParkForRun,
  resolveRecommendationCandidateSkillIds,
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
  runBy: "user-1",
  sourceType: "agent_builder",
  humanPresent: true,
  inputParams: { prompt: "write a blog" },
  ...over,
});

/** The run-derived actor the canonical resolver returns for `run()`. */
const RUN_ACTOR = {
  principalType: "HumanUser" as const,
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-a"],
  projectIds: ["proj-a"],
  platformRole: "platform_admin" as const,
};

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
  resolveAssignedSkillsActorForRun.mockReset();
  resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
  resolveAssignedSkillsActorForRun.mockResolvedValue(RUN_ACTOR);
  getAssignedSkillIdsForAgent.mockResolvedValue(["s1"]);
  readContinuationParksForRun.mockResolvedValue([]);
  recommendSkillsForAgentTask.mockResolvedValue([ranked()]);
  maybeParkCheckpoint.mockResolvedValue({ parked: true, parkId: "park-1", reevaluationIntent: false });
  // The chip-row hold is DEFAULT-ON (#2047 ruling): leave the switch UNSET so
  // every test below exercises the shipped default posture.
  delete process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
});

afterEach(() => {
  delete process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
});

describe("maybeHoldRunForRecommendation", () => {
  it("switch UNSET (the shipped default) → the hold is ACTIVE and a human-present run parks", async () => {
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    expect(maybeParkCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("explicit opt-out `off` → never parks (the pre-flip behaviour, on demand)", async () => {
    process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW = "off";
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(readContinuationParksForRun).not.toHaveBeenCalled();
  });

  it("the opt-out is trimmed + case-insensitive; a legacy explicit `on` still activates", async () => {
    process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW = "  OFF ";
    expect(
      (await maybeHoldRunForRecommendation({ run: run(), template: template() })).held,
    ).toBe(false);
    process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW = "on";
    expect(
      (await maybeHoldRunForRecommendation({ run: run(), template: template() })).held,
    ).toBe(true);
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

  it("an already-parked run reports STILL HELD and writes no second park (cinatra#2148)", async () => {
    // `held` answers "is this run held?", not "did I create a park". A retried
    // run-start (a second immediate trigger, a double-clicked Run) must NOT be
    // told the run is free to dispatch while the human is still deciding.
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-x", checkpoint: "recommendation", status: "parked" },
    ]);
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    if (out.held) expect(out.parkId).toBe("park-x");
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

  it("a TTL-fail-closed park never re-holds — the run is re-dispatchable, not stranded", async () => {
    // The sweeper's terminal `policy_unresolved` is the always-resume floor: the
    // run stays an un-dispatched pending_input run (the documented #2067
    // abandoned-setup behaviour) and the next Run press dispatches it.
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-x", checkpoint: "recommendation", status: "policy_unresolved" },
    ]);
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(false);
    expect(out.reason).toContain("policy_unresolved");
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2148 finding 1 — candidate resolution runs WITH the run's actor.
// ---------------------------------------------------------------------------
describe("resolveRecommendationCandidateSkillIds (cinatra#2148 finding 1)", () => {
  it("resolves with the RUN's actor scope (org/team/project) — not the actor-free call", async () => {
    getAssignedSkillIdsForAgent.mockResolvedValue(["s1", "org-scoped-skill"]);
    const ids = await resolveRecommendationCandidateSkillIds({
      run: run(),
      packageName: "@vendor/agent",
    });
    expect(ids).toEqual(["s1", "org-scoped-skill"]);
    expect(resolveAssignedSkillsActorForRun).toHaveBeenCalledWith({
      id: "run-1",
      runBy: "user-1",
      orgId: "org-1",
      sourceType: "agent_builder",
      dependentInstallId: null,
    });
    expect(getAssignedSkillIdsForAgent).toHaveBeenCalledWith("@vendor/agent", {
      principalId: "user-1",
      teamIds: ["team-a"],
      projectIds: ["proj-a"],
      organizationId: "org-1",
    });
  });

  it("DROPS platformRole — the candidate set never rides the platform-admin bypass", async () => {
    await resolveRecommendationCandidateSkillIds({ run: run(), packageName: "@vendor/agent" });
    const filter = getAssignedSkillIdsForAgent.mock.calls[0][1] as Record<string, unknown>;
    // RUN_ACTOR is a platform_admin; the filter handed to the resolver carries
    // ONLY the bounding shape `confirmRunSkillSelectionAction` uses.
    expect(filter).not.toHaveProperty("platformRole");
    expect(Object.keys(filter).sort()).toEqual([
      "organizationId",
      "principalId",
      "projectIds",
      "teamIds",
    ]);
  });

  it("FAIL-CLOSED: an unresolvable actor falls back to EXACTLY today's actor-free call", async () => {
    resolveAssignedSkillsActorForRun.mockResolvedValue(undefined);
    getAssignedSkillIdsForAgent.mockResolvedValue(["s1"]);
    const ids = await resolveRecommendationCandidateSkillIds({
      run: run({ runBy: null }),
      packageName: "@vendor/agent",
    });
    expect(ids).toEqual(["s1"]);
    expect(getAssignedSkillIdsForAgent).toHaveBeenCalledWith("@vendor/agent");
    expect(getAssignedSkillIdsForAgent.mock.calls[0]).toHaveLength(1);
  });

  it("a THROWING actor resolver still resolves (degrades to the actor-free call)", async () => {
    resolveAssignedSkillsActorForRun.mockRejectedValue(new Error("membership read down"));
    getAssignedSkillIdsForAgent.mockResolvedValue(["s1"]);
    const ids = await resolveRecommendationCandidateSkillIds({
      run: run(),
      packageName: "@vendor/agent",
    });
    expect(ids).toEqual(["s1"]);
    expect(getAssignedSkillIdsForAgent.mock.calls[0]).toHaveLength(1);
  });

  it("a THROWING catalog read degrades to [] (a recommendation read never fails a run)", async () => {
    getAssignedSkillIdsForAgent.mockRejectedValue(new Error("catalog down"));
    await expect(
      resolveRecommendationCandidateSkillIds({ run: run(), packageName: "@vendor/agent" }),
    ).resolves.toEqual([]);
  });

  // -- presentation intersection (cinatra#2148, codex round) ----------------
  it("a VIEWER scope INTERSECTS the run's set — a non-owner never learns the owner's scoped skills", async () => {
    getAssignedSkillIdsForAgent.mockImplementation(
      async (_pkg: string, actor?: { principalId?: string }) =>
        actor?.principalId === "user-1"
          ? ["s1", "owner-personal-skill", "org-scoped-skill"] // the RUN owner's set
          : ["s1"], // a run-READ-only viewer's own entitlement
    );
    const ids = await resolveRecommendationCandidateSkillIds({
      run: run(),
      packageName: "@vendor/agent",
      viewer: { principalId: "viewer-9", teamIds: [], projectIds: [], organizationId: "org-1" },
    });
    expect(ids).toEqual(["s1"]);
    expect(ids).not.toContain("owner-personal-skill");
    expect(ids).not.toContain("org-scoped-skill");
  });

  it("the OWNER as viewer sees the FULL run set (the org-scoped assignment still appears)", async () => {
    getAssignedSkillIdsForAgent.mockResolvedValue(["s1", "org-scoped-skill"]);
    const ids = await resolveRecommendationCandidateSkillIds({
      run: run(),
      packageName: "@vendor/agent",
      viewer: { principalId: "user-1", teamIds: ["team-a"], projectIds: ["proj-a"], organizationId: "org-1" },
    });
    expect(ids).toEqual(["s1", "org-scoped-skill"]);
  });

  it("FAIL-CLOSED: a THROWING viewer resolve yields NO chips (never the wider run set)", async () => {
    getAssignedSkillIdsForAgent.mockImplementation(
      async (_pkg: string, actor?: { principalId?: string }) => {
        if (actor?.principalId === "viewer-9") throw new Error("viewer scope read down");
        return ["s1", "org-scoped-skill"];
      },
    );
    await expect(
      resolveRecommendationCandidateSkillIds({
        run: run(),
        packageName: "@vendor/agent",
        viewer: { principalId: "viewer-9", teamIds: [], projectIds: [], organizationId: "org-1" },
      }),
    ).resolves.toEqual([]);
  });

  it("the HOLD decision scores over the ACTOR-SCOPED candidate set", async () => {
    // Only the actor-scoped call returns the org-scoped assignment; the
    // actor-FREE call (the pre-#2148 behaviour) returns only the system skill.
    getAssignedSkillIdsForAgent.mockImplementation(
      async (_pkg: string, actor?: unknown) => (actor ? ["s1", "org-scoped-skill"] : ["s1"]),
    );
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    expect(getAssignedSkillIdsForAgent).toHaveBeenCalledWith(
      "@vendor/agent",
      expect.objectContaining({ organizationId: "org-1" }),
    );
    // The scorer is bounded by the actor-scoped set, so an org-scoped assignment
    // is a candidate the chip-row can offer.
    expect(recommendSkillsForAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToSkillIds: ["s1", "org-scoped-skill"] }),
    );
  });

  it("a HEADLESS run never resolves candidates at all (S3 path byte-unchanged)", async () => {
    const out = await maybeHoldRunForRecommendation({
      run: run({ humanPresent: false }),
      template: template(),
    });
    expect(out.held).toBe(false);
    expect(resolveAssignedSkillsActorForRun).not.toHaveBeenCalled();
    expect(getAssignedSkillIdsForAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2148 AC-d — no NEW park path can strand a run: every hold parks
// through the SAME `maybeParkCheckpoint` seam, keyed by the SAME per-run event
// id and with NO ttl override, so the S0 TTL/sweeper contract covers the new
// call sites exactly as it covers the original ones.
// ---------------------------------------------------------------------------
describe("park-seam invariants (cinatra#2148 AC-d)", () => {
  it("parks through maybeParkCheckpoint with the per-run event id and the DEFAULT TTL", async () => {
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    expect(maybeParkCheckpoint).toHaveBeenCalledTimes(1);
    const [outcome, input] = maybeParkCheckpoint.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(outcome).toMatchObject({ kind: "park", checkpoint: "recommendation" });
    expect(input).toEqual({
      runId: "run-1",
      eventId: "recommendation:run-start:run-1",
      policyDecisionId: null,
    });
    // No ttlMs override ⇒ the store's DEFAULT_TTL_MS applies ⇒ the sweeper's
    // TTL fail-close covers this park (never an indefinite strand).
    expect(input).not.toHaveProperty("ttlMs");
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
