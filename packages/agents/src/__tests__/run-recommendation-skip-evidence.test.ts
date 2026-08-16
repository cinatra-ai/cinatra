/**
 * A SKIP IS A DECISION, SO IT MUST BE RECORDED — AND THE RECORD IS THE CARD.
 *
 * `getRunRecommendationHoldStateAction` answers `skipped` only when durable skip
 * evidence exists, and the §V card reads that answer to settle in place. Two
 * consequences, and this file pins both:
 *
 *   1. The evidence must cover EVERY candidate the row offered, not only the
 *      scorer-recommended ones. The hold fires whenever there is any candidate
 *      at all, so a row made entirely of FORCED candidates was a skip that left
 *      no trace — the state action then said `none` and the card vanished from
 *      the conversation instead of settling.
 *   2. The write may not be best-effort. Releasing the run while losing the
 *      record produces exactly the vanishing card the fix exists to remove, so a
 *      failed write refuses the decision and leaves the run parked and
 *      retryable.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-recommendation-skip-evidence.test.ts
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
const writeRunRejectedRecommendations = vi.fn();
const publishRecommendationHoldResume = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  requireActorContext: (...a: unknown[]) => requireActorContext(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: vi.fn(() => []),
  hasRunRecommendationSkip: vi.fn(() => false),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("../recommendation-hold", () => ({
  decodeRecommendationHoldRef: () => null,
  encodeRecommendationHoldRef: () => "ref-park-1",
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  releaseRecommendationParkForRun: (...a: unknown[]) => releaseRecommendationParkForRun(...a),
  resolveRecommendationCandidateSkillIds: (...a: unknown[]) =>
    resolveRecommendationCandidateSkillIds(...a),
  publishRecommendationHoldResume: (...a: unknown[]) => publishRecommendationHoldResume(...a),
  recommendationHoldThreadId: (run: { id: string }) => run.id,
  RECOMMENDATION_DECISION_REFUSAL: "refused",
  RECOMMENDATION_SKIP_NOT_RECORDED: "not-recorded",
}));
vi.mock("../recommendation-interception", () => ({
  getRunRecommendations: (...a: unknown[]) => getRunRecommendations(...a),
}));
vi.mock("../run-actions", () => ({
  triggerAgentRun: (...a: unknown[]) => triggerAgentRun(...a),
}));
vi.mock("../server-actions", () => ({
  confirmRunSkillSelectionAction: vi.fn(),
}));

import { skipRunRecommendationAction } from "../run-recommendation-actions";

const RUN_ID = "run-1";
const USER = "user-1";

/** One RECOMMENDED and one FORCED candidate — the shape a real row offers. */
const CANDIDATES = [
  { skillId: "skill-ranked", skillRevisionId: "rev-a", recommended: true, rank: 1, name: "ranked" },
  { skillId: "skill-forced", skillRevisionId: "rev-b", recommended: false, rank: null, name: "forced" },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({ user: { id: USER } });
  requireActorContext.mockResolvedValue({ principalId: USER });
  readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    runBy: USER,
    templateId: "tpl-1",
    status: "pending_input",
    inputParams: {},
  });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@vendor/agent" });
  readRecommendationParkForRun.mockResolvedValue({ id: "park-1", status: "released" });
  releaseRecommendationParkForRun.mockResolvedValue(true);
  resolveRecommendationCandidateSkillIds.mockResolvedValue(["skill-ranked", "skill-forced"]);
  getRunRecommendations.mockResolvedValue(CANDIDATES);
  triggerAgentRun.mockResolvedValue({ ok: true });
  writeRunRejectedRecommendations.mockReturnValue(undefined);
});

describe("skip evidence covers every offered candidate", () => {
  it("writes a row for the FORCED candidate too, with a null rank", async () => {
    await skipRunRecommendationAction({ runId: RUN_ID });

    expect(writeRunRejectedRecommendations).toHaveBeenCalledTimes(1);
    const written = writeRunRejectedRecommendations.mock.calls[0][0] as {
      runId: string;
      rejected: Array<{ skillId: string; recommendationSource: string; recommendedRank: number | null }>;
    };
    expect(written.runId).toBe(RUN_ID);
    expect(written.rejected).toHaveLength(2);

    const forced = written.rejected.find((r) => r.skillId === "skill-forced");
    const ranked = written.rejected.find((r) => r.skillId === "skill-ranked");
    // Both are the same DECISION, so both carry the skip stamp the state action
    // reads back.
    expect(forced?.recommendationSource).toBe("user_skipped");
    expect(ranked?.recommendationSource).toBe("user_skipped");
    // The rank is what still tells them apart: offered-but-never-ranked is
    // NULL, a scorer rank is the rank.
    expect(forced?.recommendedRank).toBeNull();
    expect(ranked?.recommendedRank).toBe(1);
  });

  it("a row of ONLY forced candidates still records the skip", async () => {
    // The exact shape that used to leave no trace: nothing recommended, so the
    // old filter wrote nothing and the card cleared instead of settling.
    getRunRecommendations.mockResolvedValue([CANDIDATES[1]]);

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    const written = writeRunRejectedRecommendations.mock.calls[0][0] as {
      rejected: Array<{ skillId: string; recommendedRank: number | null }>;
    };
    expect(written.rejected).toHaveLength(1);
    expect(written.rejected[0].skillId).toBe("skill-forced");
    expect(written.rejected[0].recommendedRank).toBeNull();
    expect(result.ok).toBe(true);
    expect(triggerAgentRun).toHaveBeenCalled();
  });
});

describe("the evidence write is not best-effort", () => {
  it("REFUSES the skip when the evidence write throws — the run is not released", async () => {
    writeRunRejectedRecommendations.mockImplementation(() => {
      throw new Error("evidence store down");
    });

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(result.ok).toBe(false);
    // The run stays parked and decidable: no release, no dispatch, and the card
    // keeps its controls instead of vanishing.
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("still RELEASES when the row had nothing on it to skip", async () => {
    // Zero candidates is not a failed write. Refusing here would leave a person
    // holding a card they cannot dismiss, so the release proceeds as before —
    // the refusal is aimed at losing a decision, not at an empty row.
    getRunRecommendations.mockResolvedValue([]);

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(triggerAgentRun).toHaveBeenCalled();
  });

  it("releases and dispatches once the evidence IS written", async () => {
    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(writeRunRejectedRecommendations).toHaveBeenCalledTimes(1);
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});
