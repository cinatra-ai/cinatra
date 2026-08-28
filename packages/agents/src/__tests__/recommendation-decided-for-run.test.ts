/**
 * "DECIDED" HAS ONE DEFINITION, AND THE RUN PAGE ASKS FOR IT (cinatra#3047).
 *
 * The plan sentence this serves: "The agentic run progress card appears once the
 * skills are decided; no skill inside it can be selected." The run panel used to
 * answer that from a recommendation card it mounted itself; that mount is gone —
 * the row has one owner and one place — so the run screen answers it server-side
 * and hands the panel a boolean.
 *
 * WHAT THIS FILE EXISTS TO STOP. The obvious server-side test is the park's
 * STATUS: `released` means a human answered, everything else does not. It is
 * wrong, and it is wrong in the direction that puts the forbidden picker back on
 * the page. The park's status and the decision's evidence are written by two
 * different writers and are not atomic: a confirm or a skip that RACES the TTL
 * sweeper leaves the park at `policy_unresolved` with a real selection set or a
 * real skip record behind it. `resolveRecommendationHoldStateForActor` reads
 * that run as `confirmed`/`skipped` — its ladder is evidence-first for every
 * terminal park — so a status-only test would disagree with the very card the
 * settled chips are drawn from.
 *
 * So the predicate reads the SAME ladder, and this suite walks the whole matrix
 * of park status × evidence, with the race as its own named case.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-decided-for-run.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evidence = vi.hoisted(() => ({
  selected: false,
  skipped: false,
  /** When set, the store read THROWS — the give-up case. */
  broken: false,
}));

vi.mock("@/lib/run-selected-skill-revisions", () => ({
  SKIP_RECOMMENDATION_SOURCE: "user_skipped",
  decidedSkillsFromEvidence: () => [],
  hasRunRecommendationSkip: () => {
    if (evidence.broken) throw new Error("store unreachable");
    return evidence.skipped;
  },
  hasRunSelectedSkillRevisions: () => {
    if (evidence.broken) throw new Error("store unreachable");
    return evidence.selected;
  },
  readRunRejectedRecommendations: () => [],
  readRunSelectedSkillRevisions: () => [],
  readRunRecommendationOfferedSet: async () => null,
  writeRunRecommendationOfferedSet: async () => undefined,
  writeRunRecommendationSkip: () => undefined,
}));

beforeEach(() => {
  evidence.selected = false;
  evidence.skipped = false;
  evidence.broken = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

const load = async () => {
  const mod = await import("../run-recommendation-core");
  return mod.recommendationDecidedForRun;
};

describe("recommendationDecidedForRun — the run's own reading of an answered question", () => {
  it("a run that never held is not decided, whatever is on file", async () => {
    const decided = await load();
    evidence.selected = true;
    expect(decided({ runId: "run-3047", parkStatus: null })).toBe(false);
    expect(decided({ runId: "run-3047", parkStatus: undefined })).toBe(false);
  });

  it("a LIVE hold is the question still open, not an answer", async () => {
    const decided = await load();
    evidence.selected = true;
    expect(decided({ runId: "run-3047", parkStatus: "parked" })).toBe(false);
  });

  it("a released park with a selection set is CONFIRMED — decided", async () => {
    const decided = await load();
    evidence.selected = true;
    expect(decided({ runId: "run-3047", parkStatus: "released" })).toBe(true);
  });

  it("a released park with a skip record is SKIPPED — decided", async () => {
    const decided = await load();
    evidence.skipped = true;
    expect(decided({ runId: "run-3047", parkStatus: "released" })).toBe(true);
  });

  it("THE RACE: a policy_unresolved park with real evidence is decided too", async () => {
    // The defect a status-only test carries. The confirm (or the skip) wrote its
    // evidence and the TTL sweeper won the park's CAS before the release landed,
    // so the run reads `policy_unresolved` and IS decided — which is exactly what
    // the card draws for it. Answering `false` here is what would let the panel
    // offer this run's skills again, below a settled chip row that says they were
    // already chosen.
    const decided = await load();
    evidence.selected = true;
    expect(decided({ runId: "run-3047", parkStatus: "policy_unresolved" })).toBe(true);
    evidence.selected = false;
    evidence.skipped = true;
    expect(decided({ runId: "run-3047", parkStatus: "policy_unresolved" })).toBe(true);
  });

  it("a terminal park that NOBODY answered is not decided", async () => {
    // The TTL sweeper's ordinary outcome: the hold expired undecided, there is
    // no selection set and no skip on file, and the card draws no DOM for it.
    const decided = await load();
    expect(decided({ runId: "run-3047", parkStatus: "policy_unresolved" })).toBe(false);
    expect(decided({ runId: "run-3047", parkStatus: "released" })).toBe(false);
  });

  it("an empty run id decides nothing", async () => {
    const decided = await load();
    evidence.selected = true;
    expect(decided({ runId: "", parkStatus: "released" })).toBe(false);
  });

  it("a read that GIVES UP leaves the panel as it was — not decided", async () => {
    // Fails toward drawing the picker, which is the posture this rule has always
    // taken for a read it cannot complete: the alternative withdraws a run's own
    // affordance on a store hiccup.
    const decided = await load();
    evidence.broken = true;
    expect(decided({ runId: "run-3047", parkStatus: "released" })).toBe(false);
  });
});
