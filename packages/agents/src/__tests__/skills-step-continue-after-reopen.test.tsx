// @vitest-environment jsdom
//
// CONTINUE AFTER COMING BACK TO THE STEP (cinatra#3047, the ninth proof round's
// settlement finding).
//
// THE ROUND'S OBSERVATION, and its own stated plausible cause. Two graded walks
// opened another step from its rail entry and came back before pressing
// Continue; both settled the gate, advanced the run, and left ZERO
// `run_selected_skill_revisions` rows where the walk that pressed Continue
// straight from the step left two.
//
// WHAT THE DRAWING ASKS. The ratified review page, section I: "a reader may come
// back and change the selection, and Continue keeps it." The ratified lifecycle
// cards page, section V: "the boxes are set together, and Continue keeps the
// whole row in one act."
//
// WHAT THIS FILE MEASURES. The screen half of the road: coming back to the step
// is a fresh MOUNT of the card — the reader's own box moves are not carried
// across it, and the boxes come back on the reading's own defaults. So the two
// things that could lose the row here are pinned: that a re-mounted step whose
// reading carries the row confirms it rather than taking `release`'s SKIP
// branch, and that a re-mount whose reading has not landed yet draws NO Continue
// at all, so no press can turn "not read yet" into "the reader kept nothing".
// The other half — the READING itself losing the row on the re-open — is pinned
// against the resolver in `skills-step-reopened-row-survives.test.ts`.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-continue-after-reopen.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const confirmRunRecommendationAction = vi.fn();
const skipRunRecommendationAction = vi.fn();
const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (...a: unknown[]) => holdStateMock(...a),
  confirmRunRecommendationAction: (...a: unknown[]) => confirmRunRecommendationAction(...a),
  skipRunRecommendationAction: (...a: unknown[]) => skipRunRecommendationAction(...a),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";

const RUN_ID = "run-3047-reopen";
const PKG = "@cinatra-ai/author-agent";
const HOLD_REF = "hold-ref-3047-reopen";

function pill(skillId: string, name: string, rank: number) {
  return {
    skillId,
    skillRevisionId: `${skillId}@1`,
    name,
    vendorName: "Acme",
    score: 0.9,
    rank,
    recommended: true,
    scoredFeatures: [],
  };
}

/** The two-pill hold the round drove, both boxes on the scorer's own default. */
const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: HOLD_REF,
  canDecide: true,
  recommendations: [pill("skill-a", "Skill A", 1), pill("skill-b", "Skill B", 2)],
};

function mountStep() {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"));

beforeEach(() => {
  confirmRunRecommendationAction.mockReset();
  skipRunRecommendationAction.mockReset();
  holdStateMock.mockReset();
  confirmRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
  skipRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
});

afterEach(() => {
  cleanup();
});

describe("the reader opens another step and comes back", () => {
  it("keeps the whole row: Continue confirms both skills, and never takes the skip", async () => {
    holdStateMock.mockResolvedValue(HELD);

    // The first opening of the step: the row is there, nothing pressed.
    const first = mountStep();
    await waitFor(() => expect(boxes(first.container)).toHaveLength(2));

    // Selecting another rail entry unmounts this step's page…
    cleanup();
    // …and coming back to the Skills entry mounts it again, from the reading.
    const again = mountStep();
    await waitFor(() => expect(boxes(again.container)).toHaveLength(2));
    expect(boxes(again.container).map((b) => b.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
    ]);

    const button = again.container.querySelector<HTMLElement>("[data-skills-step-continue]");
    expect(button).not.toBeNull();
    await act(async () => {
      fireEvent.click(button as HTMLElement);
    });

    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();
    expect(confirmRunRecommendationAction.mock.calls[0]?.[0]).toMatchObject({
      runId: RUN_ID,
      holdRef: HOLD_REF,
      confirmedSkillIds: ["skill-a", "skill-b"],
    });
  });

  it("offers NO Continue while the re-opened step's reading has not landed", async () => {
    // A press in this window would be a decision taken over a row nobody has
    // read yet, and `release` with nothing kept is the SKIP — the shape the
    // round measured. The step draws no control until the reading is in.
    let land: (v: unknown) => void = () => {};
    holdStateMock.mockImplementation(
      () => new Promise((resolve) => { land = resolve; }),
    );
    const { container } = mountStep();
    await act(async () => {});
    expect(container.querySelector("[data-skills-step-continue]")).toBeNull();
    expect(confirmRunRecommendationAction).not.toHaveBeenCalled();
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();

    await act(async () => {
      land(HELD);
    });
    await waitFor(() =>
      expect(container.querySelector("[data-skills-step-continue]")).not.toBeNull(),
    );
  });
});
