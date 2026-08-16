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
 *   3. EVERY successful skip leaves a durable marker — there is no releasing
 *      path that records nothing. When drift leaves no candidate to name (the
 *      scorer and the assignments both come back empty, or the template reads
 *      back with no package), the marker names the RUN instead of a skill. The
 *      only non-recording ending is a REFUSAL, which keeps the hold.
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
/** The reserved id the run-level skip marker occupies (see the store module). */
const RUN_LEVEL_SKIP_SENTINEL = "__run_level_skip__";
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: vi.fn(() => []),
  hasRunRecommendationSkip: vi.fn(() => false),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
  RUN_LEVEL_SKIP_SENTINEL_SKILL_ID: "__run_level_skip__",
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("../recommendation-hold", () => ({
  RECOMMENDATION_SKIP_NOT_RECORDED_CODE: "recommendation_skip_not_recorded",
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

  it("REFUSES the skip when the TEMPLATE READ throws — a read failure is not 'no package'", async () => {
    // The read used to be wrapped in `.catch(() => null)`, which answered "this
    // run has no package" whenever the database did not answer at all. The skip
    // then walked past the evidence write and released — the same lost decision
    // a failed write produces, arriving by a quieter route.
    readAgentTemplateById.mockRejectedValue(new Error("template store down"));

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(result.ok).toBe(false);
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("records the skip against the ASSIGNED set when the scorer drifted to empty", async () => {
    // A live hold proves a non-empty offered set existed, so an empty scorer
    // result at decision time is DRIFT, not an empty row. The assignments behind
    // the hold are still the offered set, so the skip is recorded against them
    // and the card settles.
    getRunRecommendations.mockResolvedValue([]);

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    const written = writeRunRejectedRecommendations.mock.calls[0][0] as {
      rejected: Array<{ skillId: string; skillRevisionId: string | null; recommendedRank: number | null }>;
    };
    expect(written.rejected.map((r) => r.skillId)).toEqual(["skill-ranked", "skill-forced"]);
    // Offered, never ranked, and no revision the scorer could pin.
    expect(written.rejected.every((r) => r.recommendedRank === null)).toBe(true);
    expect(written.rejected.every((r) => r.skillRevisionId === null)).toBe(true);
    expect(result.ok).toBe(true);
    expect(triggerAgentRun).toHaveBeenCalled();
  });

  it("marks the RUN when the drift left no candidate to name", async () => {
    // Both the scorer AND the assignments came back empty. Releasing here
    // unrecorded is what made this Skip fail to settle: the state reader found
    // no selection and no skip row, answered `none`, and the card disappeared.
    // The marker names the run instead of a skill.
    getRunRecommendations.mockResolvedValue([]);
    resolveRecommendationCandidateSkillIds.mockResolvedValue([]);

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    const written = writeRunRejectedRecommendations.mock.calls[0][0] as {
      rejected: Array<{ skillId: string; recommendationSource: string; recommendedRank: number | null }>;
    };
    expect(written.rejected).toHaveLength(1);
    expect(written.rejected[0].skillId).toBe(RUN_LEVEL_SKIP_SENTINEL);
    expect(written.rejected[0].recommendationSource).toBe("user_skipped");
    expect(written.rejected[0].recommendedRank).toBeNull();
    expect(result.ok).toBe(true);
    expect(triggerAgentRun).toHaveBeenCalled();
  });

  it("marks the RUN when the template reads back with no package name", async () => {
    // A template that genuinely carries no package is a fact, not a fault — it
    // is the other branch that leaves nothing to name, and it takes the same
    // run-level marker rather than releasing on no record at all.
    readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: null });

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    const written = writeRunRejectedRecommendations.mock.calls[0][0] as {
      rejected: Array<{ skillId: string }>;
    };
    expect(written.rejected).toHaveLength(1);
    expect(written.rejected[0].skillId).toBe(RUN_LEVEL_SKIP_SENTINEL);
    expect(result.ok).toBe(true);
    expect(triggerAgentRun).toHaveBeenCalled();
  });

  it("NEVER releases without a durable marker, on any successful path", async () => {
    // The invariant the individual cases above add up to, asserted as one
    // statement so a new branch cannot quietly join the list without a marker.
    const drifts: Array<() => void> = [
      () => undefined,
      () => getRunRecommendations.mockResolvedValue([]),
      () => {
        getRunRecommendations.mockResolvedValue([]);
        resolveRecommendationCandidateSkillIds.mockResolvedValue([]);
      },
      () => readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: null }),
    ];

    for (const drift of drifts) {
      vi.clearAllMocks();
      requireAuthSession.mockResolvedValue({ user: { id: USER } });
      readAgentRunById.mockResolvedValue({
        id: RUN_ID, runBy: USER, templateId: "tpl-1", status: "pending_input", inputParams: {},
      });
      readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@vendor/agent" });
      readRecommendationParkForRun.mockResolvedValue({ id: "park-1", status: "released" });
      releaseRecommendationParkForRun.mockResolvedValue(true);
      resolveRecommendationCandidateSkillIds.mockResolvedValue(["skill-ranked", "skill-forced"]);
      getRunRecommendations.mockResolvedValue(CANDIDATES);
      triggerAgentRun.mockResolvedValue({ ok: true });
      drift();

      const result = await skipRunRecommendationAction({ runId: RUN_ID });

      expect(result.ok).toBe(true);
      expect(writeRunRejectedRecommendations).toHaveBeenCalledTimes(1);
      const written = writeRunRejectedRecommendations.mock.calls[0][0] as {
        rejected: unknown[];
      };
      expect(written.rejected.length).toBeGreaterThan(0);
    }
  });

  it("carries a TYPED code on the refusal, not only prose", async () => {
    // A caller that offers a retry branches on the code; the message is what a
    // person reads and may be reworded at any time.
    writeRunRejectedRecommendations.mockImplementation(() => {
      throw new Error("evidence store down");
    });

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("recommendation_skip_not_recorded");
  });
});

describe("skip is a runBy-owner decision, fail-closed", () => {
  it("REFUSES a run this session does not own", async () => {
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      runBy: "someone-else",
      templateId: "tpl-1",
      status: "pending_input",
      inputParams: {},
    });

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(result.ok).toBe(false);
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("REFUSES an UNOWNED run instead of admitting every session", async () => {
    // The reachable case, not a hypothetical: the chat dispatch boundary stamps
    // the launch origin as a constant but carries a user id only for a human
    // principal, so a chat-origin run can be created with no `runBy` and the
    // hold still fires on it. A guard that reads "nobody claimed it, so anybody
    // may" would let any authenticated session release and dispatch that run.
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      runBy: null,
      templateId: "tpl-1",
      status: "pending_input",
      inputParams: {},
    });

    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(result.ok).toBe(false);
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
    expect(releaseRecommendationParkForRun).not.toHaveBeenCalled();
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("releases and dispatches once the evidence IS written", async () => {
    const result = await skipRunRecommendationAction({ runId: RUN_ID });

    expect(writeRunRejectedRecommendations).toHaveBeenCalledTimes(1);
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});
