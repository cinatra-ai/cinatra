// @vitest-environment jsdom
//
// A REFUSED DECISION IS DECIDABLE THE MOMENT IT IS ON SCREEN
// (cinatra#3047, review point B — the re-shoot round).
//
// WHAT WENT WRONG. Continue read its inertness off TWO answers that do not move
// together: the step's own declared reading (`data-skills-step-submitted`, written
// synchronously on the press and cleared with the refusal message in ONE commit)
// and `useTransition`'s `pending`, which React clears in a LATER commit of its
// own. So between the two there is a real, painted frame in which the row says
// the hold is live and the step decidable — the refusal message sitting under
// the list, the boxes movable again — while the one control the step offers is
// greyed out. A reader who looks at that frame is told to decide again and given
// nothing to press; a suite that looks at it under load reads a disabled button
// on a decidable step, which is how this was caught.
//
// WHAT IS PINNED. Not \x22the end state settles correctly\x22 — that was always true
// and is why the frame survived a round. This walks EVERY commit React makes
// while the refusal is on screen and requires the control to agree with the
// reading in each of them: whenever the row declares itself decidable, Continue
// is pressable. The observer is the assertion; the final state is checked too,
// so the test cannot pass by the step never being decidable at all.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-refusal-is-decidable-on-every-commit.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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

const RUN_ID = "run-3047";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: "hold-ref-3047",
  canDecide: true,
  recommendations: [
    {
      skillId: "skill-blog",
      skillRevisionId: "skill-blog@1",
      name: "Blog content",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ],
};

const REFUSAL = "This run's skill selection cannot be decided from here.";

const row = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");

beforeEach(() => {
  holdStateMock.mockReset();
  holdStateMock.mockResolvedValue(HELD);
  confirmRunRecommendationAction.mockReset();
  confirmRunRecommendationAction.mockResolvedValue({ ok: false, error: REFUSAL });
  skipRunRecommendationAction.mockReset();
  skipRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("A refused decision, commit by commit", () => {
  it("never paints a decidable step with a Continue that cannot be pressed", async () => {
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    // Every commit React makes from the press onward, as the DOM actually was.
    const frames: string[] = [];
    const observer = new MutationObserver(() => {
      const rowEl = row(container);
      if (!rowEl?.textContent?.includes(REFUSAL)) return;
      const declaredDecidable = rowEl.getAttribute("data-skills-step-submitted") === "false";
      const pressable = continueButton(container)?.hasAttribute("disabled") === false;
      frames.push(`decidable=${declaredDecidable} pressable=${pressable}`);
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(row(container)!.textContent).toContain(REFUSAL));
    observer.disconnect();

    // The refusal WAS painted (the walk is not vacuous)…
    expect(frames.length).toBeGreaterThan(0);
    // …and it declared the step decidable in every one of those frames…
    expect(frames.every((f) => f.startsWith("decidable=true"))).toBe(true);
    // …so Continue was pressable in every one of them.
    expect(frames.filter((f) => !f.endsWith("pressable=true"))).toEqual([]);

    // And the settled reading agrees, so a second decision really can be taken.
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(false);
    confirmRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(2));
  });
});
