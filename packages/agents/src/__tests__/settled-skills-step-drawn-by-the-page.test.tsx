// @vitest-environment jsdom
//
// THE SETTLED SKILLS STEP IS DRAWN FROM THE PAGE'S OWN READING (cinatra#3047,
// review point C — the re-shoot round).
//
// WHAT THE RE-SHOOT MEASURED. After Continue, the run recorded one confirmed and
// one cleared skill and the rail marked the step complete — and the detail
// column beside it was EMPTY: zero `[data-run-recommendation-chip-row]`, zero
// `[data-skills-step-checkbox]`, no Continue, before the run started and again
// while it ran.
//
// WHY IT COULD BE EMPTY AT ALL, which is the thing this file pins. The settled
// step's whole content came from ONE client round trip made after hydration:
// the card resolved the state itself and drew NO DOM until that answer landed
// — `if (state === null || state.state === "none") return null`. A round trip
// that does not land (a refused read, a spent retry budget, a resolve that never
// answers) therefore left the column blank, and the frame around it cannot see
// that: `isRunSurfaceStepSelectable` can only ask whether the surface is a
// non-null element, "so a step whose surface renders nothing on the client can
// still open an empty column" (`run-surface-rail-step.ts`).
//
// WHAT IS PINNED HERE:
//
//   1. the page's own settled reading — the run's recorded decision rows,
//      resolved SERVER-SIDE — draws the step, with no client answer at all:
//      one box per decision row, ticked for a confirmed skill and clear for a
//      cleared one, disabled, and NO Continue;
//   2. it draws on the FIRST paint, before any effect has run — which is what
//      makes it survive a fresh page load;
//   3. a client answer that DOES land outranks it, because the client answer is
//      the fresher reading of the same run;
//   4. a host that hands no page reading is unchanged — the conversation
//      surfaces still draw nothing until their own resolve answers.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/settled-skills-step-drawn-by-the-page.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: false })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: false })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { resetDrawnRecommendationReadings } from "../run-recommendation-reading-register";

const RUN_ID = "run-3047-page-reading";
const KEPT = "@cinatra-ai/chat:blog-idea-matcher";
const CLEARED = "@cinatra-ai/chat:blog-writing";

/** The reading the RUN PAGE resolves for a settled step, server-side. */
const PAGE_READING = {
  state: "confirmed" as const,
  skillNames: ["Blog Idea Matcher"],
  decided: [
    { skillId: KEPT, name: "Blog Idea Matcher", mark: "confirmed" as const },
    { skillId: CLEARED, name: "Blog Writing", mark: "skipped" as const },
  ],
  holdRef: "hold-ref-3047-page",
  runStarted: true,
  canDecide: true,
};

function mount(opts: {
  host: "run_card" | "chat_thread";
  initialState?: typeof PAGE_READING | null;
}) {
  return render(
    <LifecycleCardSurfaceProvider host={opts.host}>
      <RecommendationHoldCard
        runId={RUN_ID}
        agentPackageName=""
        wireRef={null}
        initialState={opts.initialState ?? null}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"));
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");

beforeEach(() => {
  // A FRESH READER PER ARM (cinatra#3062, fix leg 3). The card now remembers the
  // row it DREW, keyed by run, so that a remount redraws it instead of emptying
  // the turn — §V's "a row the reader did see keeps its place in the turn". The
  // arms below reuse one run id, so each one declares a reader who has been
  // shown nothing yet.
  resetDrawnRecommendationReadings();
  holdStateMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the settled step draws from the page's own reading", () => {
  it("draws one box per decision row with NO client answer at all", async () => {
    // The read never answers — the exact condition under which the column was
    // photographed empty.
    holdStateMock.mockRejectedValue(new Error("the read did not complete"));
    const { container } = mount({ host: "run_card", initialState: PAGE_READING });

    // FIRST PAINT, before any effect could have landed: the step is already
    // drawn. No `waitFor` — that is the point of the assertion.
    expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
    const drawn = boxes(container);
    expect(drawn).toHaveLength(2);
    expect(drawn.map((b) => b.getAttribute("data-skill-id"))).toEqual([KEPT, CLEARED]);
    expect(drawn.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    // DISABLED, on the vendored primitive's own terms: the native attribute the
    // control carries, and the pill's own reading of itself beside it.
    for (const b of drawn) expect(b.hasAttribute("disabled")).toBe(true);
    expect(
      Array.from(container.querySelectorAll("[data-skills-step-pill]")).map((pill) =>
        pill.getAttribute("data-skills-step-pill-editable"),
      ),
    ).toEqual(["false", "false"]);

    // A READ-ONLY reading has nothing to press.
    expect(continueButton(container)).toBeNull();

    // And it STAYS drawn once the failed read has spent itself.
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    expect(boxes(container)).toHaveLength(2);
  });

  it("the settled root states the decision it is drawing", () => {
    holdStateMock.mockRejectedValue(new Error("the read did not complete"));
    const { container } = mount({ host: "run_card", initialState: PAGE_READING });
    const root = container.querySelector<HTMLElement>("[data-run-recommendation-chip-row]")!;
    expect(root.getAttribute("data-run-recommendation-settled")).toBe("true");
    expect(root.getAttribute("data-run-recommendation-decision")).toBe("confirmed");
    expect(root.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(root.getAttribute("data-skills-step-editable")).toBe("false");
  });

  it("a client answer that lands OUTRANKS the page's reading", async () => {
    holdStateMock.mockResolvedValue({
      ...PAGE_READING,
      decided: [{ skillId: KEPT, name: "Blog Idea Matcher", mark: "confirmed" as const }],
      skillNames: ["Blog Idea Matcher"],
    });
    const { container } = mount({ host: "run_card", initialState: PAGE_READING });
    expect(boxes(container)).toHaveLength(2);
    await waitFor(() => expect(boxes(container)).toHaveLength(1));
    expect(boxes(container)[0]!.getAttribute("data-skill-id")).toBe(KEPT);
  });

  it("a host with NO page reading is unchanged — it draws nothing until its own read answers", async () => {
    holdStateMock.mockRejectedValue(new Error("the read did not complete"));
    const { container } = mount({ host: "chat_thread", initialState: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    expect(container.querySelector("[data-run-recommendation-chip-row]")).toBeNull();
  });
});
