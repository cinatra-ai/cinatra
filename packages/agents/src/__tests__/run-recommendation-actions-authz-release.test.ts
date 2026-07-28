/**
 * cinatra#2148 (codex round) — two defects the actor-threading fix exposed in
 * the chip-row DECISION actions:
 *
 *   1. `getRunRecommendationHoldStateAction` loaded the run with a BARE
 *      `readAgentRunById(runId)`, which SKIPS `enforceRunAccess`. Any
 *      authenticated caller holding a run id could read the hold state — and,
 *      once the candidate set became actor-scoped, the run owner's scoped skill
 *      names with it. The run must now load THROUGH the access door, and the
 *      presented set must be intersected with the VIEWER's own entitlement.
 *   2. `releaseAndDispatch` swallowed a failed park release. `triggerAgentRun`
 *      then short-circuited on the still-LIVE park and returned ok, so the
 *      action reported `dispatched: true` for a run that never moved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuthSession = vi.fn();
const requireActorContext = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRecommendationParkForRun = vi.fn();
const releaseRecommendationParkForRun = vi.fn();
const resolveRecommendationCandidateSkillIds = vi.fn();
const getRunRecommendations = vi.fn();
const triggerAgentRun = vi.fn();
const confirmRunSkillSelectionAction = vi.fn();
const readRunSelectedSkillRevisions = vi.fn();
const hasRunRecommendationSkip = vi.fn();
const writeRunRejectedRecommendations = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  requireActorContext: (...a: unknown[]) => requireActorContext(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: (...a: unknown[]) => readRunSelectedSkillRevisions(...a),
  hasRunRecommendationSkip: (...a: unknown[]) => hasRunRecommendationSkip(...a),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  resolveRecommendationCandidateSkillIds: (...a: unknown[]) =>
    resolveRecommendationCandidateSkillIds(...a),
}));
vi.mock("../recommendation-interception", () => ({
  getRunRecommendations: (...a: unknown[]) => getRunRecommendations(...a),
}));
vi.mock("../run-actions", () => ({
  triggerAgentRun: (...a: unknown[]) => triggerAgentRun(...a),
}));
vi.mock("../server-actions", () => ({
  confirmRunSkillSelectionAction: (...a: unknown[]) => confirmRunSkillSelectionAction(...a),
}));

import {
  getRunRecommendationHoldStateAction,
  skipRunRecommendationAction,
} from "../run-recommendation-actions";

const USER = "user-1";
const RUN = {
  id: "run-1",
  templateId: "tpl-1",
  orgId: "org-1",
  runBy: USER,
  sourceType: "agent_builder",
  inputParams: { prompt: "write a blog" },
  status: "pending_input",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({ user: { id: USER } });
  requireActorContext.mockResolvedValue({
    principalId: USER,
    organizationId: "org-1",
    teamIds: ["team-a"],
    projectIds: ["proj-a"],
    projectGrants: [{ projectId: "proj-a", role: "read" }],
    platformRole: "platform_admin",
    orgRole: "org_admin",
  });
  readAgentRunById.mockResolvedValue({ ...RUN });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@vendor/agent" });
  readRecommendationParkForRun.mockResolvedValue({
    id: "park-1",
    checkpoint: "recommendation",
    status: "parked",
  });
  resolveRecommendationCandidateSkillIds.mockResolvedValue(["s1", "org-scoped-skill"]);
  getRunRecommendations.mockResolvedValue([
    {
      skillId: "org-scoped-skill",
      skillRevisionId: "org-scoped-skill@1",
      name: "Org Scoped",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ]);
  releaseRecommendationParkForRun.mockResolvedValue(true);
  triggerAgentRun.mockResolvedValue({ ok: true });
  readRunSelectedSkillRevisions.mockReturnValue([]);
  hasRunRecommendationSkip.mockReturnValue(false);
});

describe("getRunRecommendationHoldStateAction — run access door (cinatra#2148)", () => {
  it("loads the run THROUGH the access door WITH role hints (no over-admit, no false deny)", async () => {
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state.state).toBe("held");
    expect(readAgentRunById).toHaveBeenCalledWith(
      "run-1",
      { actorType: "human", source: "ui", userId: USER },
      // Without these hints the door falsely DENIES a platform-admin /
      // org-admin / policy-authorized same-org reader.
      {
        platformRole: "platform_admin",
        orgRole: "org_admin",
        teamIds: ["team-a"],
        projectGrants: [{ projectId: "proj-a", role: "read" }],
        actorOrganizationId: "org-1",
      },
    );
  });

  it("a DENIED run read yields no row — and never even probes the park", async () => {
    // enforceRunAccess throws AuthzError for a run this session may not read.
    readAgentRunById.mockRejectedValue(new Error("AuthzError: forbidden"));
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toEqual({ state: "none" });
    expect(readRecommendationParkForRun).not.toHaveBeenCalled();
    expect(resolveRecommendationCandidateSkillIds).not.toHaveBeenCalled();
  });

  it("presents the candidate set INTERSECTED with the viewer's own entitlement", async () => {
    await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(resolveRecommendationCandidateSkillIds).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "run-1", runBy: USER }),
      packageName: "@vendor/agent",
      viewer: {
        principalId: USER,
        teamIds: ["team-a"],
        projectIds: ["proj-a"],
        organizationId: "org-1",
      },
    });
  });

  it("FAIL-CLOSED: an unresolvable viewer scope renders no row", async () => {
    requireActorContext.mockRejectedValue(new Error("no actor"));
    const state = await getRunRecommendationHoldStateAction({ runId: "run-1" });
    expect(state).toEqual({ state: "none" });
    expect(resolveRecommendationCandidateSkillIds).not.toHaveBeenCalled();
  });
});

describe("releaseAndDispatch — a live park is never reported as dispatched (cinatra#2148)", () => {
  it("a FAILED release returns a retryable error, not a false success", async () => {
    releaseRecommendationParkForRun.mockResolvedValue(false);
    // The park is STILL live after the release attempt.
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "parked",
    });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not release/i);
    // Critically: we never claim a dispatch that did not happen.
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("a THROWING release is equally a retryable error (never swallowed into success)", async () => {
    releaseRecommendationParkForRun.mockRejectedValue(new Error("sweeper down"));
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-1",
      checkpoint: "recommendation",
      status: "parked",
    });
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: an UNREADABLE park after release is treated as still-held", async () => {
    // "I could not confirm the release" must never become "dispatched".
    releaseRecommendationParkForRun.mockResolvedValue(false);
    readRecommendationParkForRun.mockImplementation(async () => {
      throw new Error("park read down");
    });
    const res = await skipRunRecommendationAction({ runId: "run-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not release/i);
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("a SUCCESSFUL release dispatches through the canonical triggerAgentRun", async () => {
    releaseRecommendationParkForRun.mockResolvedValue(true);
    readRecommendationParkForRun
      // 1st call: the skip-evidence path's own park read is not used; the
      // post-release verification sees a RELEASED park.
      .mockResolvedValue({ id: "park-1", checkpoint: "recommendation", status: "released" });

    const res = await skipRunRecommendationAction({ runId: "run-1" });

    expect(res).toEqual({ ok: true, dispatched: true });
    expect(triggerAgentRun).toHaveBeenCalledWith({ runId: "run-1", templateSlug: "tpl-1" });
  });
});
