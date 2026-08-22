// @vitest-environment jsdom
/**
 * THE ZERO-CHIP SETTLED READING (cinatra#2893) — the card that used to vanish.
 *
 * THE DEFECT. A recommendation hold settles with an empty decided set: the run
 * was skipped, and by settle time the evidence names no skill on either side
 * (nothing selected, nothing rejected). `run-recommendation-chip-row.tsx`
 * returned `null` for that row, so the card left the transcript entirely —
 * nothing said the question had been asked, answered, or with what outcome.
 * That `null` was honest at the time: §V drew settled faces PER CHIP only, and
 * a row with no chips had no ratified reading to draw.
 *
 * THE DRAWING THIS PINS. §V now has one. From the design page this branch pins:
 *
 *   "A settled row with nothing to state per skill still states the outcome.
 *    Where the hold settles and the recorded set names NO SKILL AT ALL, there is
 *    no chip to draw — and the card does NOT disappear. In place of the row it
 *    draws one OUTCOME PANEL: the outcome word, and beneath it the one sentence
 *    for that outcome."
 *   "The decider is named only when it can be named. The panel reads 'Skipped
 *    by' a person when the record carries a SAFELY DISPLAYABLE NAME, and the
 *    OUTCOME WORD ALONE when it does not."
 *
 * WHAT THIS SUITE HOLDS:
 *
 *   1. THE RED. Settled + an empty decided set renders the ratified reading.
 *      Against the trunk this branch was cut from, every assertion in the first
 *      test fails on `null`.
 *   2. RESOLVER AND FACE AGREE, IN ONE TEST. The third test drives the REAL
 *      `getRunRecommendationHoldStateAction` through the candidate-drift
 *      scenario, asserts the answer it gives, and then renders the card from
 *      THAT LITERAL ANSWER — not from a hand-written copy of it. A resolver that
 *      changed its answer and a renderer that changed its face cannot pass this
 *      test while disagreeing with each other.
 *   3. THE DECIDER IS NEVER GUESSED. The named face appears only when a name is
 *      given, and nothing on this trunk gives one. The run-level skip record is
 *      here and it does record who decided — `run_recommendation_skips.
 *      skipped_by`, written from the deciding session's user id — but an
 *      IDENTIFIER is not a name, the resolver reads none, and the drawing
 *      forbids pressing one into service as one. So the shipped reading is the
 *      outcome-only face, asserted below as the fact it is rather than implied.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/zero-chip-settled-reading.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "SlidersHorizontal", "X", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(),
}));

// ── The REAL resolver's collaborators, so the drift scenario is DRIVEN rather
//    than asserted about. Only the stores are stubbed; the branch under test is
//    the shipped one.
const requireAuthSession = vi.fn();
const requireActorContext = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRunCoOwners = vi.fn(async (..._a: unknown[]) => []);
const readRecommendationParkForRun = vi.fn();
const resolveRecommendationCandidateSkillIds = vi.fn(async (..._a: unknown[]) => []);
const readRunSelectedSkillRevisions = vi.fn((..._a: unknown[]) => [] as never[]);
const readRunRejectedRecommendations = vi.fn((..._a: unknown[]) => [] as never[]);
const hasRunRecommendationSkip = vi.fn((..._a: unknown[]) => true);

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  requireActorContext: (...a: unknown[]) => requireActorContext(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run-selected-skill-revisions")>();
  return {
    ...actual,
    readRunSelectedSkillRevisions: (...a: unknown[]) => readRunSelectedSkillRevisions(...a),
    readRunRejectedRecommendations: (...a: unknown[]) => readRunRejectedRecommendations(...a),
    hasRunRecommendationSkip: (...a: unknown[]) => hasRunRecommendationSkip(...a),
  };
});
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
}));
vi.mock("../recommendation-hold", () => ({
  RECOMMENDATION_DECISION_REFUSAL: "refused",
  decodeRecommendationHoldRef: vi.fn(),
  encodeRecommendationHoldRef: vi.fn(),
  publishRecommendationHoldResume: vi.fn(),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  recommendationHoldThreadId: (run: { id: string }) => run.id,
  releaseRecommendationParkForRun: vi.fn(),
  resolveRecommendationCandidateSkillIds: (...a: unknown[]) =>
    resolveRecommendationCandidateSkillIds(...a),
}));
vi.mock("../recommendation-interception", () => ({ getRunRecommendations: vi.fn(async () => []) }));
vi.mock("../run-actions", () => ({ triggerAgentRun: vi.fn() }));

const RUN_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  requireAuthSession.mockResolvedValue({ user: { id: "user-1" } });
  requireActorContext.mockResolvedValue({ organizationId: "org-1", teamIds: [], projectIds: [] });
  readAgentRunById.mockResolvedValue({ id: RUN_ID, templateId: "tpl-1", inputParams: {} });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@cinatra-test/agent" });
  // THE CANDIDATE-DRIFT SCENARIO: the hold was released (so the row is settled)
  // and by settle time nothing is on either side of the evidence — no skill was
  // selected and none was recorded as rejected, because the candidates the hold
  // was offered on re-derived to nothing. The skip itself IS recorded.
  readRecommendationParkForRun.mockResolvedValue({ runId: RUN_ID, status: "released" });
  readRunSelectedSkillRevisions.mockReturnValue([]);
  readRunRejectedRecommendations.mockReturnValue([]);
  hasRunRecommendationSkip.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Decision = Parameters<
  typeof import("../run-recommendation-chip-row").RunRecommendationChipRow
>[0]["decision"];

async function renderRow(decision: Decision) {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RunRecommendationChipRow
        runId={RUN_ID}
        agentPackageName="@cinatra-test/agent"
        decision={decision}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const panel = () => document.querySelector("[data-recommendation-outcome-panel]");

describe("§V — the settled reading for an empty decided set (cinatra#2893)", () => {
  it("RED ON MAIN: a settled, skipped row with no decided skill draws the outcome panel, not nothing", async () => {
    const { container } = await renderRow({ kind: "skipped", decided: [] });
    await waitFor(() => expect(panel()).not.toBeNull());

    // The card did not vanish: it is still a `recommendation_hold` card root,
    // declaring its kind, its host and its settled state — the three attributes
    // a capture of this card is identified by.
    const root = container.querySelector("[data-run-recommendation-chip-row]");
    expect(root).not.toBeNull();
    expect(root!.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root!.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(root!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(root!.getAttribute("data-run-recommendation-settled")).toBe("true");

    // "the outcome word, and beneath it the one sentence for that outcome".
    expect(panel()!.getAttribute("data-recommendation-outcome")).toBe("skipped");
    expect(panel()!.textContent).toContain("Skipped");
    expect(panel()!.textContent).toContain(
      "The recommendation is recorded as skipped, and the run went ahead with its default skill set.",
    );

    // There is no chip, because there is no skill to state one for — and
    // nothing left to press, exactly as the settled row has nothing.
    expect(container.querySelectorAll("[data-recommendation-chip]")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
  });

  it("names the decider only when it can be named — and never invents one", async () => {
    // The NAMED face, when a safely displayable name is supplied.
    const named = await renderRow({
      kind: "skipped",
      decided: [],
      decidedByName: "Dana Okafor",
    });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(panel()!.textContent).toContain("Skipped by Dana Okafor");
    expect(panel()!.getAttribute("data-conformance-id")).toBe(
      "recommendation-settled-outcome-named",
    );
    named.unmount();
    cleanup();

    // The FALLBACK face, when none is. "Skipped" alone — no dangling "by", no
    // placeholder, and nothing pressed into service as a name.
    await renderRow({ kind: "skipped", decided: [] });
    await waitFor(() => expect(panel()).not.toBeNull());
    const text = panel()!.textContent ?? "";
    expect(text).toContain("Skipped");
    expect(text).not.toMatch(/Skipped\s+by/);
    expect(panel()!.getAttribute("data-conformance-id")).toBe(
      "recommendation-settled-outcome-only",
    );
  });

  it("the resolver's answer and the rendered face agree — the SAME answer drives both", async () => {
    const { getRunRecommendationHoldStateAction } = await import("../run-recommendation-actions");

    // 1. What the SHIPPED resolver answers for the drift scenario.
    const state = await getRunRecommendationHoldStateAction({ runId: RUN_ID });
    expect(state.state).toBe("skipped");
    expect(state.state === "skipped" && state.decided).toEqual([]);

    // 2. The card, mapped from THAT answer exactly as `RecommendationHoldCard`
    //    maps it — the object below is the resolver's own, not a copy of it.
    if (state.state !== "skipped") throw new Error("unreachable: asserted above");
    await renderRow({ kind: "skipped", decided: state.decided });
    await waitFor(() => expect(panel()).not.toBeNull());

    // 3. The face states the outcome the resolver recorded, and the fallback
    //    face is the true one because the answer carries no decider at all.
    expect(panel()!.getAttribute("data-recommendation-outcome")).toBe("skipped");
    expect(panel()!.getAttribute("data-conformance-id")).toBe(
      "recommendation-settled-outcome-only",
    );
    expect(Object.keys(state)).not.toContain("decidedByName");
  });

  it("NEGATIVE CONTROL: a settled row that DOES name skills still draws chips, not the panel", async () => {
    // The panel is reached by an empty decided set, not by settling. If this
    // went green with the panel showing, the first test would prove nothing.
    const { container } = await renderRow({
      kind: "skipped",
      decided: [{ skillId: "skill-send", name: "Schedule send", mark: "skipped" }],
    });
    await waitFor(() =>
      expect(container.querySelectorAll("[data-recommendation-chip]")).toHaveLength(1),
    );
    expect(panel()).toBeNull();
  });
});
