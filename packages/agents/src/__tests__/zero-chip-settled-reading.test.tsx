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
    // The pre-start selection clear (cinatra#3047) is a STORE write — stubbed
    // like the rest of them, though the spread keeps the pure exports real.
    clearRunSelectedSkillRevisionsBeforeStart: vi.fn(() => 0),
  // The pre-start selection REPLACE (cinatra#3047) — the hold-bound confirm's
  // one guarded write. `true` = it applied, which is what a pre-start run gives.
  replaceRunSelectedSkillRevisionsBeforeStart: vi.fn(() => true),
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

/**
 * THE PANEL HAS NO HOST LEFT, since cinatra#3047's re-shoot round and
 * cinatra#3062.
 *
 * The bordered outcome panel is §V's zero-chip settled face for a host that
 * draws the per-chip row, and no declared host draws that row any more:
 * cinatra#3047 moved the run page and then the review page's gate region — the
 * run's own second page — and cinatra#3062 moves the chat and the widget. With
 * checkboxes there is no skip ACT for an outcome word to report, so the settled
 * all-clear reading everywhere is the row itself with every box clear, and where
 * the hold offered nothing at all the row says so in its own words.
 *
 * WHAT THIS FILE STILL PINS is cinatra#2893's criterion, which is not the panel
 * but what the panel existed to satisfy: a settled, skipped row with NO decided
 * skill must draw its card and state something, rather than vanish and leave a
 * reader with an empty column. That is measured here on the reading that ships,
 * on every declared host, together with the panel's absence on each of them and
 * the rule that a decider is never invented. The per-box all-clear reading — the
 * different case, where the hold DID offer skills and the reader kept none — is
 * pinned in `skills-step-all-clear-is-the-skip.test.tsx`.
 */
async function renderRow(
  decision: Decision,
  host: "page_gate_region" | "chat_thread" | "run_card" | "site_widget" = "page_gate_region",
) {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <RunRecommendationChipRow
        runId={RUN_ID}
        agentPackageName="@cinatra-test/agent"
        decision={decision}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const panel = () => document.querySelector("[data-recommendation-outcome-panel]");
/** The checklist's own list region, which states its emptiness in words. */
const list = () => document.querySelector("[data-skills-step-list]");

describe("§V — the settled reading for an empty decided set (cinatra#2893)", () => {
  it("THE CRITERION: a settled, skipped row with no decided skill draws its CARD, not nothing", async () => {
    const { container } = await renderRow({ kind: "skipped", decided: [] });
    await waitFor(() =>
      expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );

    // The card did not vanish: it is still a `recommendation_hold` card root,
    // declaring its kind, its host and its settled state — the three attributes
    // a capture of this card is identified by. THAT is what cinatra#2893 fixed,
    // and it is untouched by which face states the emptiness.
    const root = container.querySelector("[data-run-recommendation-chip-row]");
    expect(root).not.toBeNull();
    expect(root!.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root!.getAttribute("data-lifecycle-card-host")).toBe("page_gate_region");
    expect(root!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(root!.getAttribute("data-run-recommendation-settled")).toBe("true");
    expect(root!.getAttribute("data-run-recommendation-decision")).toBe("skipped");

    // …and it STATES the emptiness rather than drawing an empty column. The
    // bordered plate is not how it states it any more — no host draws that —
    // so the words are read off the list region the checklist ships.
    expect(panel()).toBeNull();
    expect(list()).not.toBeNull();
    expect(list()!.textContent?.trim()).toBeTruthy();

    // There is no chip, because there is no skill to state one for — and
    // nothing left to press, exactly as the settled row has nothing.
    expect(container.querySelectorAll("[data-recommendation-chip]")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
  });

  // THE WIDGET IS NOT DRIVEN HERE, and the reason is a property of the product
  // rather than a gap: `site_widget` is not a cookie host, so the surface
  // provider declares no host for it without a credential declaration, and a
  // bare mount would fall to the undeclared-host reading rather than to the
  // widget's own. It is driven through its broker transport in
  // `recommendation-hold-card.test.tsx`, whose four-host arm compares its
  // drawing with the other three byte for byte.
  it.each(["run_card", "chat_thread", "page_gate_region"] as const)(
    "the outcome panel is NOT drawn on %s — its skills row states an all-clear reading instead",
    async (host) => {
      // Review point 2 (cinatra#3047) for the run page and then the review
      // page's gate region, and cinatra#3062 for the conversation: no skip
      // outcome, no decider naming, and none of the panel's visuals — on any
      // declared host, because every one of them draws the checklist.
      const { container } = await renderRow(
        { kind: "skipped", decided: [], decidedByName: "Dana Okafor" },
        host,
      );
      expect(panel()).toBeNull();
      expect(container.textContent).not.toContain("Dana Okafor");
      expect(container.textContent).not.toContain("Skipped");
      // The card itself is still there, still declaring what it is.
      const root = container.querySelector("[data-run-recommendation-chip-row]");
      expect(root).not.toBeNull();
      expect(root!.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(root!.getAttribute("data-run-recommendation-settled")).toBe("true");
    },
  );

  it("never names a decider — the face that could is drawn on no host", async () => {
    // THE RULE THIS ARM CARRIES survives the panel's retirement, and gets
    // stricter rather than weaker: it used to be "name the decider only when it
    // can be safely named, and never invent one", and the two faces it drove
    // (`recommendation-settled-outcome-named` and `-outcome-only`) are the
    // panel's. No host draws the panel, so nothing prints a decider at all —
    // and a name supplied by the record must not leak into the reading by any
    // other route either. Both inputs are driven, so a face that started
    // printing one again would be caught.
    const named = await renderRow({
      kind: "skipped",
      decided: [],
      decidedByName: "Dana Okafor",
    });
    await waitFor(() => expect(list()).not.toBeNull());
    expect(panel()).toBeNull();
    expect(named.container.textContent).not.toContain("Dana Okafor");
    expect(named.container.textContent ?? "").not.toMatch(/\bby\s/);
    expect(document.querySelector("[data-conformance-id='recommendation-settled-outcome-named']"))
      .toBeNull();
    named.unmount();
    cleanup();

    // …and with no name in the record, the same reading and still no dangling
    // "by", no placeholder, nothing pressed into service as a name.
    const anon = await renderRow({ kind: "skipped", decided: [] });
    await waitFor(() => expect(list()).not.toBeNull());
    expect(panel()).toBeNull();
    expect(anon.container.textContent ?? "").not.toMatch(/\bby\s/);
    expect(document.querySelector("[data-conformance-id='recommendation-settled-outcome-only']"))
      .toBeNull();
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
    const { container } = await renderRow({ kind: "skipped", decided: state.decided });
    await waitFor(() =>
      expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );

    // 3. The card states the outcome the resolver recorded — on its root, which
    //    is where the reading publishes it now that the panel that carried the
    //    word is drawn on no host — and it names no decider, because the
    //    answer carries none at all.
    const root = container.querySelector("[data-run-recommendation-chip-row]")!;
    expect(root.getAttribute("data-run-recommendation-decision")).toBe("skipped");
    expect(root.getAttribute("data-run-recommendation-settled")).toBe("true");
    expect(panel()).toBeNull();
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
