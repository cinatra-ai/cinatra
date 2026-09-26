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

  it("is inert WHILE the decision is in flight, and live again once it is home", async () => {
    // WHAT THIS ARM USED TO PIN, and why it moved (cinatra#3062, the second
    // capture). It read "goes INERT the moment it is submitted", and it kept the
    // step inert AFTER the decision came back OK as well, on the reasoning that
    // "a press on them would do nothing at all". That reasoning was true before
    // this card could be decided twice. It is not true now: §V's own reading —
    // "Continue does not close the row… For as long as the run has not started,
    // a reader who comes back to the Skills step is shown the same pills with
    // the boxes still able to take a change and Continue still beneath them, and
    // may change the selection" — is a press that does something, and the row
    // already takes it on the settled-but-not-started reading.
    //
    // Kept inert after the press left the card frozen wherever the authority's
    // reading does not change, which is what a conversation does: a real capture
    // measured a chat card at rest with every box disabled and a greyed Continue
    // on a run that had not started. §V draws no such reading — the disabled
    // floor beneath disabled boxes belongs to the reader who may NOT shape the
    // run — so the window this latch names is the IN-FLIGHT one its own contract
    // names, and the arm measures both of its edges.
    //
    // AND THE OUTCOME IS NOT A BOOLEAN (cinatra#3062, convergence round). This
    // arm settled with `dispatched: true` and then demanded the editable reading
    // — but `dispatched: true` is the run CROSSING INTO EXECUTION, which §V
    // draws read-only with no Continue at all. It is measured on its own below.
    let settle: (v: { ok: true; dispatched: boolean }) => void = () => {};
    confirmRunRecommendationAction.mockImplementation(
      () => new Promise((resolve) => { settle = resolve as typeof settle; }),
    );
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    // IN FLIGHT: the whole reading states that it is, and a second press is not
    // a second decision.
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("true");
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(true);
    for (const box of container.querySelectorAll('[role="checkbox"]')) {
      expect(box.hasAttribute("disabled")).toBe(true);
    }
    fireEvent.click(continueButton(container)!);
    expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1);

    // HOME, AND THE RUN HAS NOT STARTED: the drawing's reading comes back —
    // the same pills, the boxes able to take a change, Continue beneath them.
    await act(async () => {
      settle({ ok: true, dispatched: false });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false"),
    );
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(false);
    for (const box of container.querySelectorAll('[role="checkbox"]')) {
      expect(box.hasAttribute("disabled")).toBe(false);
    }
  });

  it("a press that STARTS the run takes §V's started reading, not the editable one", async () => {
    // §V: "Once the run is running, the selection is fixed and the row is
    // read-only: each pill states in its own box whether that skill was applied
    // to the run. No Continue is left beneath it, and nothing is left to press."
    //
    // `{ ok: true, dispatched: true }` is that moment: the release crossed into
    // execution. Handing the guards back on it drew live boxes and a live
    // Continue over a running run, and a second press was genuinely takeable —
    // the Skip path would then write durable skip evidence for a run dispatched
    // on a Confirm.
    let settle: (v: { ok: true; dispatched: boolean }) => void = () => {};
    confirmRunRecommendationAction.mockImplementation(
      () => new Promise((resolve) => { settle = resolve as typeof settle; }),
    );
    const { container } = mount();
    await waitFor(() => expect(continueButton(container)).not.toBeNull());

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    await act(async () => {
      settle({ ok: true, dispatched: true });
      await Promise.resolve();
    });

    // THE FLOOR IS GONE, and so is everything a press could reach.
    await waitFor(() => expect(continueButton(container)).toBeNull());
    expect(container.querySelector("[data-skills-step-floor]")).toBeNull();
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    // …and the pills are still there, stating what the run applied.
    expect(container.querySelectorAll('[role="checkbox"]').length).toBeGreaterThan(0);
    for (const box of container.querySelectorAll('[role="checkbox"]')) {
      expect(box.hasAttribute("disabled")).toBe(true);
    }
    // A second decision is not reachable at all.
    expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1);
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();
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
