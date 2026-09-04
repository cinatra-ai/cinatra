/**
 * WHAT CONTINUE DOES ON THE SERVER (cinatra#3047, review point B).
 *
 * The screen's half — one Continue below the list, one submission under a double
 * press, no Continue once the step is settled — is pinned in
 * `skills-step-continue.test.tsx`. This is the other half: Continue takes the
 * SHIPPED decision path, and that path is what refuses a decision once the run
 * has moved past the hold it was taken against.
 *
 * NO NEW WRITE PATH. The step presses `confirmRunRecommendationAction` /
 * `skipRunRecommendationAction` — the same two entries the chip row has always
 * pressed — and this suite drives THOSE, with the decision core underneath them
 * real and only the store, the session and the dispatcher stubbed. So what is
 * pinned is the behaviour the run page actually gets, not a restatement of it.
 *
 * THE HOLD-INSTANCE BINDING IS THE "MOVED ON" GATE. `resolveDecisionHold` runs
 * BEFORE any write ("a decision aimed at a hold the run has moved past leaves no
 * trace on the run at all"): a ref naming the run's CURRENT park is honoured,
 * one naming a park the run has left is refused, and a RETRY naming the same
 * hold after it was released is still this run's hold and is accepted — which is
 * what makes a re-submitted Continue idempotent rather than destructive.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-continue-release.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuthSession = vi.fn();
const requireActorContext = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRecommendationParkForRun = vi.fn();
const releaseRecommendationParkForRun = vi.fn();
const triggerAgentRun = vi.fn();
const confirmRunSkillSelectionAction = vi.fn();
const readRunCoOwners = vi.fn();
const publishRecommendationHoldResume = vi.fn();
const writeRunRejectedRecommendations = vi.fn();
const writeRunRecommendationSkip = vi.fn();
const readRunRecommendationOfferedSet = vi.fn();
const readRunSelectedSkillRevisions = vi.fn();
const readRunRejectedRecommendations = vi.fn();
const hasRunRecommendationSkip = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  requireActorContext: (...a: unknown[]) => requireActorContext(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/run-selected-skill-revisions")>()),
  readRunSelectedSkillRevisions: (...a: unknown[]) => readRunSelectedSkillRevisions(...a),
  readRunRejectedRecommendations: (...a: unknown[]) => readRunRejectedRecommendations(...a),
  hasRunRecommendationSkip: (...a: unknown[]) => hasRunRecommendationSkip(...a),
  readRunRecommendationOfferedSet: (...a: unknown[]) => readRunRecommendationOfferedSet(...a),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  writeRunRecommendationSkip: (...a: unknown[]) => writeRunRecommendationSkip(...a),
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
}));
// The hold module is stubbed EXCEPT for its codec, which is modelled here as a
// transparent one: the binding under test compares the decoded `{runId, holdId}`
// against the run's park, and a real AES envelope would only hide that compare
// behind a key.
vi.mock("../recommendation-hold", () => ({
  RECOMMENDATION_DECISION_REFUSAL: "This run's skill selection cannot be decided from here.",
  RECOMMENDATION_SKIP_NOT_RECORDED:
    "your skip was not recorded — the run is still waiting, please retry",
  RECOMMENDATION_SKIP_NOT_RECORDED_CODE: "recommendation_skip_not_recorded",
  decodeRecommendationHoldRef: (ref: string) => {
    try {
      return JSON.parse(ref) as { runId: string; holdId: string };
    } catch {
      return null;
    }
  },
  encodeRecommendationHoldRef: (v: unknown) => JSON.stringify(v),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  resolveRecommendationCandidateSkillIds: vi.fn(async () => ["skill-blog"]),
  publishRecommendationHoldResume: (...a: unknown[]) => publishRecommendationHoldResume(...a),
  recommendationHoldThreadId: (run: { id: string; templateId?: string | null }) =>
    run.templateId && run.templateId.length > 0 ? run.templateId : run.id,
}));
vi.mock("../recommendation-interception", () => ({
  getRunRecommendations: vi.fn(async () => []),
}));
vi.mock("../run-actions", () => ({
  triggerAgentRun: (...a: unknown[]) => triggerAgentRun(...a),
}));
vi.mock("../server-actions", () => ({
  confirmRunSkillSelectionAction: (...a: unknown[]) => confirmRunSkillSelectionAction(...a),
}));

import {
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} from "../run-recommendation-actions";

const USER = "user-1";
const RUN_ID = "run-3047";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
/** The ref the held card handed the step — this run, this park. */
const HOLD_REF = JSON.stringify({ runId: RUN_ID, holdId: "park-live" });
/** The ref of a hold the run has already left behind. */
const STALE_REF = JSON.stringify({ runId: RUN_ID, holdId: "park-previous" });

const RUN = {
  id: RUN_ID,
  templateId: "tpl-3047",
  orgId: "org-1",
  runBy: USER,
  sourceType: "agent_builder",
  inputParams: { prompt: "draft a blog post" },
  status: "pending_input",
};

/** Exactly what the step submits when Blog content is checked. */
const CONTINUE = {
  runId: RUN_ID,
  agentPackageName: PKG,
  confirmedSkillIds: ["skill-blog"],
  promptText: "{}",
  holdRef: HOLD_REF,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({ user: { id: USER } });
  requireActorContext.mockResolvedValue({
    principalId: USER,
    organizationId: "org-1",
    teamIds: [],
    projectIds: [],
    projectGrants: [],
    platformRole: "platform_admin",
    orgRole: "org_admin",
  });
  readAgentRunById.mockResolvedValue({ ...RUN });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-3047", packageName: PKG });
  readRecommendationParkForRun.mockResolvedValue({
    id: "park-live",
    checkpoint: "recommendation",
    status: "parked",
  });
  releaseRecommendationParkForRun.mockResolvedValue(true);
  confirmRunSkillSelectionAction.mockResolvedValue({ ok: true });
  triggerAgentRun.mockResolvedValue({ ok: true });
  readRunCoOwners.mockResolvedValue([]);
  readRunSelectedSkillRevisions.mockReturnValue([]);
  readRunRejectedRecommendations.mockReturnValue([]);
  hasRunRecommendationSkip.mockReturnValue(false);
  writeRunRecommendationSkip.mockReturnValue(true);
  readRunRecommendationOfferedSet.mockResolvedValue([]);
});

describe("Continue against the run's LIVE hold", () => {
  it("writes the checked selection, releases that hold, and dispatches once", async () => {
    // The park goes terminal the moment the release lands, which is what the
    // verification read below sees.
    releaseRecommendationParkForRun.mockImplementation(async () => {
      readRecommendationParkForRun.mockResolvedValue({
        id: "park-live",
        checkpoint: "recommendation",
        status: "released",
      });
      return true;
    });

    const res = await confirmRunRecommendationAction(CONTINUE);

    expect(res).toEqual({ ok: true, dispatched: true });
    expect(confirmRunSkillSelectionAction).toHaveBeenCalledTimes(1);
    expect(confirmRunSkillSelectionAction.mock.calls[0][0]).toMatchObject({
      runId: RUN_ID,
      confirmedSkillIds: ["skill-blog"],
      holdId: "park-live",
    });
    expect(releaseRecommendationParkForRun).toHaveBeenCalledTimes(1);
    expect(releaseRecommendationParkForRun).toHaveBeenCalledWith(RUN_ID, "park-live");
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
  });

  it("clearing every box takes the SKIP entry, and releases the same hold", async () => {
    releaseRecommendationParkForRun.mockImplementation(async () => {
      readRecommendationParkForRun.mockResolvedValue({
        id: "park-live",
        checkpoint: "recommendation",
        status: "released",
      });
      return true;
    });

    const res = await skipRunRecommendationAction({ runId: RUN_ID, holdRef: HOLD_REF });

    expect(res).toEqual({ ok: true, dispatched: true });
    expect(writeRunRecommendationSkip).toHaveBeenCalledTimes(1);
    expect(confirmRunSkillSelectionAction).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).toHaveBeenCalledWith(RUN_ID, "park-live");
  });
});

describe("Continue once the run has MOVED ON", () => {
  it("is refused when the ref names a hold that is no longer the run's park", async () => {
    const res = await confirmRunRecommendationAction({ ...CONTINUE, holdRef: STALE_REF });

    expect(res.ok).toBe(false);
    // BEFORE ANY WRITE: nothing is selected, nothing is released, nothing runs.
    expect(confirmRunSkillSelectionAction).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a SKIP aimed at the same moved-past hold, and records nothing", async () => {
    const res = await skipRunRecommendationAction({ runId: RUN_ID, holdRef: STALE_REF });

    expect(res.ok).toBe(false);
    expect(writeRunRecommendationSkip).not.toHaveBeenCalled();
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("is refused when the run has parked AGAIN under a new hold", async () => {
    readRecommendationParkForRun.mockResolvedValue({
      id: "park-next",
      checkpoint: "recommendation",
      status: "parked",
    });

    const res = await confirmRunRecommendationAction(CONTINUE);

    expect(res.ok).toBe(false);
    expect(confirmRunSkillSelectionAction).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
  });
});

describe("a re-submitted Continue against the SAME hold", () => {
  it("is TWO calls with ONE dispatch — the retry is accepted and changes nothing", async () => {
    // DRIVEN TWICE, against one park that really transitions (found in the
    // convergence round: the earlier arm simulated the second state and called
    // the action once, which proves nothing about a retry). The park is the
    // run's own row: `parked` until the first release, `released` after it, and
    // the run leaves `pending_input` when it is dispatched — so the second call
    // sees exactly what a second Continue would see.
    let parkStatus = "parked";
    let runStatus = "pending_input";
    readRecommendationParkForRun.mockImplementation(async () => ({
      id: "park-live",
      checkpoint: "recommendation",
      status: parkStatus,
    }));
    readAgentRunById.mockImplementation(async () => ({ ...RUN, status: runStatus }));
    releaseRecommendationParkForRun.mockImplementation(async () => {
      const wasLive = parkStatus === "parked";
      parkStatus = "released";
      return wasLive;
    });
    triggerAgentRun.mockImplementation(async () => {
      runStatus = "running";
      return { ok: true };
    });

    const first = await confirmRunRecommendationAction(CONTINUE);
    const second = await confirmRunRecommendationAction(CONTINUE);

    // Both are accepted — the released park is still this run's hold, so the
    // binding matches and the retry is not the "moved on" refusal above.
    expect(first).toEqual({ ok: true, dispatched: true });
    expect(second).toEqual({ ok: true, dispatched: false });
    // WHAT THE RETRY ACTUALLY DOES, stated rather than rounded to "nothing":
    // it writes the SAME selection again (the store's write is keyed by run and
    // hold, so a repeat is a repeat of the same set, not a second decision),
    // and it asks the park to release again — which is a no-op on a park that
    // is already released.
    expect(confirmRunSkillSelectionAction).toHaveBeenCalledTimes(2);
    expect(confirmRunSkillSelectionAction.mock.calls[1][0]).toMatchObject(
      confirmRunSkillSelectionAction.mock.calls[0][0] as Record<string, unknown>,
    );
    expect(releaseRecommendationParkForRun).toHaveBeenCalledTimes(2);
    // …and the RUN is dispatched exactly once, which is the property that
    // matters: the second call finds it past `pending_input` and stops.
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
  });
});
