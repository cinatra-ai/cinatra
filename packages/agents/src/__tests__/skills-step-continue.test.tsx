// @vitest-environment jsdom
//
// THE SKILLS STEP HAS A CONTINUE BUTTON, AND IT RELEASES THE HOLD
// (cinatra#3047, review point B).
//
// The review, verbatim: "The continue button is missing on the skills
// recommendation screen."
//
// WHAT CONTINUE IS. The one control that submits the selection and releases the
// run's hold, through the SAME decision path the chips used — the shipped
// `confirmRunRecommendationAction` / `skipRunRecommendationAction` pair, with
// the hold's own opaque ref carried back on it. NO new write path is added: the
// boxes are mapped onto the per-chip decision model that already exists and
// handed to the shipped whole-row release.
//
// WHAT IS PINNED HERE:
//
//   1. Continue is drawn BELOW the list, and it is the only control on the step;
//   2. pressing it submits ONCE, with the checked set and the hold ref;
//   3. a DOUBLE press inside the in-flight window is still ONE decision — the
//      guard is synchronous, because `useTransition`'s pending flag is not;
//   4. a REFUSED decision — which is what the server answers once the run has
//      moved past this hold — leaves the row saying so, claims no decision, and
//      leaves Continue pressable again (the hold is still live);
//   5. and once the hold is SETTLED there is no Continue at all: the screen
//      refuses a second decision by drawing no way to take one.
//
// The server's half of (4) and (5) — the hold-instance binding that refuses a
// decision aimed at a hold the run has moved past — is pinned against the
// decision core in `skills-step-continue-release.test.ts`.
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/skills-step-continue.test.tsx
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

const RUN_ID = "run-3047";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
const HOLD_REF = "hold-ref-3047";

const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: HOLD_REF,
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

const SETTLED = {
  state: "confirmed" as const,
  skillNames: ["Blog content"],
  decided: [{ skillId: "skill-blog", name: "Blog content", mark: "confirmed" as const }],
};

function mount() {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const row = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const list = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-skills-step-list]");
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");

beforeEach(() => {
  holdStateMock.mockReset();
  confirmRunRecommendationAction.mockReset();
  confirmRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
  skipRunRecommendationAction.mockReset();
  skipRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Continue on the held Skills step", () => {
  beforeEach(() => {
    holdStateMock.mockResolvedValue(HELD);
  });

  it("is drawn BELOW the list, and is the step's only control", async () => {
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    const button = continueButton(container)!;
    expect(button.textContent).toBe("Continue");
    expect(
      list(container)!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(list(container)!.contains(button)).toBe(false);
    // The only thing to press inside the card.
    const pressable = Array.from(row(container)!.querySelectorAll("button")).filter(
      (b) => b.getAttribute("role") !== "checkbox",
    );
    expect(pressable).toEqual([button]);
  });

  it("submits the selection and releases the hold through the shipped decision path", async () => {
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    expect(confirmRunRecommendationAction.mock.calls[0][0]).toMatchObject({
      runId: RUN_ID,
      agentPackageName: PKG,
      confirmedSkillIds: ["skill-blog"],
      holdRef: HOLD_REF,
    });
  });

  it("is ONE decision under a double press — the guard is synchronous", async () => {
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    const button = continueButton(container)!;
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    // …and it stays one after the transition has settled.
    await new Promise((r) => setTimeout(r, 20));
    expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1);
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();
  });

  it("goes INERT the moment it is submitted — before the settled reading arrives", async () => {
    // FOUND IN THE CONVERGENCE ROUND. The synchronous guard stops a second
    // CALL; it does not stop a second PRESS from looking possible. React's
    // transition `pending` flag goes false as soon as the action resolves, and
    // the authoritative re-read lands later — so without this the reader would
    // be looking at editable boxes and a live Continue on a run that has
    // already been decided, and a press on them would do nothing at all.
    let settle: (v: { ok: true; dispatched: boolean }) => void = () => {};
    confirmRunRecommendationAction.mockImplementation(
      () => new Promise((resolve) => { settle = resolve as typeof settle; }),
    );
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    // …and once the decision comes back OK the step stays inert, because the
    // reading on screen is no longer the run's state.
    await act(async () => {
      settle({ ok: true, dispatched: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("true"),
    );
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(true);
    for (const box of container.querySelectorAll('[role="checkbox"]')) {
      expect(box.hasAttribute("disabled")).toBe(true);
    }
    fireEvent.click(continueButton(container)!);
    expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1);
  });

  it("REFUSED: says so, claims no decision, and leaves the step decidable", async () => {
    confirmRunRecommendationAction.mockResolvedValue({
      ok: false,
      error: "This run's skill selection cannot be decided from here.",
    });
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    fireEvent.click(continueButton(container)!);
    await waitFor(() =>
      expect(row(container)!.textContent).toContain(
        "This run's skill selection cannot be decided from here.",
      ),
    );
    // The row is STILL the held reading — a refusal is not a settled run.
    expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("held");
    // …and the hold is still live, so the step is INTERACTIVE again — not
    // merely re-callable.
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false");
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(false);
    confirmRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(2));
  });
});

describe("Continue once the run has moved on", () => {
  it("is not drawn at all on a settled step — the screen offers no second decision", async () => {
    holdStateMock.mockResolvedValue(SETTLED);
    const { container } = mount();
    await waitFor(() => expect(row(container)).not.toBeNull());

    expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(continueButton(container)).toBeNull();
    expect(confirmRunRecommendationAction).not.toHaveBeenCalled();
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();
  });
});
