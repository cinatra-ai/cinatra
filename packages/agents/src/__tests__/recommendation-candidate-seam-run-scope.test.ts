/**
 * THE CANDIDATE-SET SEAM CARRIES THE RUN'S FROZEN SCOPES
 * (cinatra#2815 S3, epic #2812).
 *
 * `resolveRecommendationCandidateSkillIds` is the ONE seam every run-start
 * recommendation surface resolves through. It resolved the run's ACTOR and then
 * asked for the agent's assigned skills without the run's frozen snapshot, so
 * the resolution took the sole legacy fallback: the run's project, team and
 * personal assignments never reached the candidate set, and the durable
 * organization came from whatever frame was asking.
 *
 * The scopes belong to the RUN, so they ride both arms, including the
 * actor-free one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const getAssignedSkillIdsForAgent = vi.fn();
vi.mock("@/lib/agents-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAssignedSkillIdsForAgent: (...a: unknown[]) => getAssignedSkillIdsForAgent(...a),
}));

const resolveAssignedSkillsActorForRun = vi.fn();
vi.mock("@/lib/agent-run-actor-resolve", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAssignedSkillsActorForRun: (...a: unknown[]) => resolveAssignedSkillsActorForRun(...a),
}));

import { resolveRecommendationCandidateSkillIds } from "../recommendation-hold";

const SNAPSHOT = {
  v: 1,
  orgId: "org-run",
  projectId: "proj-run",
  teamIds: ["team-run"],
  originatingHumanUserId: "user-1",
};

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-run",
  assignmentScopeSnapshot: SNAPSHOT,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAssignedSkillIdsForAgent.mockResolvedValue(["skill-a"]);
  resolveAssignedSkillsActorForRun.mockResolvedValue({
    principalId: "user-1",
    teamIds: ["team-run"],
    projectIds: ["proj-run"],
    organizationId: "org-run",
  });
});

describe("the candidate-set seam", () => {
  it("carries the run's frozen scopes on the actor-scoped arm", async () => {
    await resolveRecommendationCandidateSkillIds({
      run: RUN as never,
      packageName: "@cinatra-ai/some-agent",
    });
    const [, , runScope] = getAssignedSkillIdsForAgent.mock.calls[0] as [
      string,
      unknown,
      { snapshot?: unknown; durableOrgId?: string | null },
    ];
    expect(runScope.snapshot).toEqual(SNAPSHOT);
    expect(runScope.durableOrgId).toBe("org-run");
  });

  it("carries them on the ACTOR-FREE arm too, because they are the run's", async () => {
    resolveAssignedSkillsActorForRun.mockResolvedValue(undefined);
    await resolveRecommendationCandidateSkillIds({
      run: RUN as never,
      packageName: "@cinatra-ai/some-agent",
    });
    const [, actor, runScope] = getAssignedSkillIdsForAgent.mock.calls[0] as [
      string,
      unknown,
      { snapshot?: unknown; durableOrgId?: string | null },
    ];
    expect(actor).toBeUndefined();
    expect(runScope.snapshot).toEqual(SNAPSHOT);
  });
});
