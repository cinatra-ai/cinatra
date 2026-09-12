// @vitest-environment jsdom
//
// THE RECOMMENDATION GATE IS A STEP IN THE RUN PAGE'S RAIL (cinatra#2790, epic
// #2784 S9f).
//
// Plan (A) §6.2: "On the run page the same row sits at the trigger position, the
// top entry on the step rail, ahead of the work steps it would authorize."
// The ratified drawing `images/lifecycle-screens/design-run-surface-rail-and-gate.png`
// draws what that means: "a gate step opens the gate's own surface in place —
// right here in the run detail, under the same rail, never as a standalone
// document."
//
// WHAT WAS WRONG. The run page drew the chip row as a block in the run detail
// with no rail entry at all: the question that gates the whole run was not one
// of the run's steps, and on a run with no schedule the page had no rail. Both
// halves are pinned here as DOM facts — WHICH column the row is a descendant of,
// and WHAT is drawn beside it — because both were visible in the surface and
// neither was measurable from source.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/recommendation-rail-step.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type HoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: {
        skillId: string;
        skillRevisionId: string;
        recommended: boolean;
        name?: string;
      }[];
      holdRef: string;
    }
  | { state: "confirmed"; skillNames: string[] };

const holdStateMock = vi.fn(async (): Promise<HoldState> => ({ state: "none" }));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { ScheduleRailStepRow } from "../schedule-rail-step";
import {
  RunSurfaceRail,
  useRunStepSelection,
  type RunStepSelection,
  type RunSurfaceRailStep,
} from "../run-surface-rail";
import { recommendationRailEntry } from "../recommendation-rail-entry";
import { runSurfaceRailNumberedCount } from "../run-surface-rail-step";

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/rail-fixture-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-2790",
};

const DECIDED: HoldState = { state: "confirmed", skillNames: ["Skill A"] };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// A CARD REMEMBERS THIS RUN'S LAST AUTHORITATIVE ANSWER (cinatra#3007, fix leg
// 10), so a REBUILT card redraws it instead of blanking while its own read is on
// the wire. A browser drops that memory with the tab. A file that mounts many
// cards for the SAME run id has no such boundary, so it takes one here — every
// arm below starts from a card that has never been told anything.
beforeEach(async () => {
  const { forgetAuthorizedRecommendationAnswers } = await import(
    "../run-recommendation-chip-row"
  );
  forgetAuthorizedRecommendationAnswers();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

/** A rail row drawn by the rail BESIDE the gate steps — the run's own steps. */
function ReviewRow() {
  const selection = useRunStepSelection();
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="review-row"
      onClick={() => selection?.select("detail")}
    >
      Review
    </Button>
  );
}

/** The run detail as the screen composes it: the run's own progress section,
 *  and nothing above it (cinatra#3047, review point D). */
function RunProgress() {
  return (
    <section data-testid="run-detail-panel">
      <h2>Agentic Run Progress</h2>
    </section>
  );
}

/**
 * The run surface, composed the way `SetupScreen` composes it: ONE card mount,
 * given to the Skills step's surface and to nothing else (cinatra#3047, review
 * point D — "every HITL shows on its own dedicated page"). The run detail is the
 * run's own panel; the settled row is reached by selecting its step.
 */
function surface(opts: {
  hasRecommendationStep?: boolean;
  hasScheduleStep?: boolean;
  settled?: boolean;
  initialSelection: RunStepSelection;
}) {
  const card = (
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard
        runId="run-2790"
        agentPackageName="@cinatra-test/rail-fixture-agent"
        wireRef={null}
      />
    </LifecycleCardSurfaceProvider>
  );
  const steps: RunSurfaceRailStep[] = [];
  if (opts.hasRecommendationStep !== false) {
    steps.push({
      key: "recommendation",
      row: <RecommendationRailStepRow settled={opts.settled === true} />,
      surface: card,
    });
  }
  if (opts.hasScheduleStep !== false) {
    steps.push({
      key: "schedule",
      // THE SCHEDULE'S NUMERAL IS THE RAIL'S RULE (cinatra#3047): the Skills
      // entry above draws its own glyph and consumes none, so the schedule is
      // "1" whether or not it is the second gate row — the same arithmetic the
      // screen applies.
      row: (
        <ScheduleRailStepRow
          host="run_card"
          displayStep={runSurfaceRailNumberedCount(steps.map((step) => step.key)) + 1}
        />
      ),
      surface: <div data-testid="schedule-surface" />,
    });
  }
  return (
    <div
      className="flex items-start gap-6"
      data-run-detail-contract=""
      data-conformance-id="run-surface"
    >
      <RunSurfaceRail
        steps={steps}
        rail={<ReviewRow />}
        detail={<RunProgress />}
        initialSelection={opts.initialSelection}
      />
    </div>
  );
}

function renderRunSurface(opts: Parameters<typeof surface>[0]) {
  return render(surface(opts));
}

const railColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-step-rail-column]")!;
const detailColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-detail-column]")!;
const chipRow = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const recommendationRow = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-conformance-id="recommendation-rail-step"]');

describe("a LIVE hold — the gate opens in the run detail, under the same rail", () => {
  it("draws the chip row inside the run-detail column and NOT inside the rail column", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = renderRunSurface({ initialSelection: "recommendation" });

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    const rail = railColumn(container);
    const detail = detailColumn(container);
    const row = chipRow(container)!;
    // The two columns are siblings inside the run-detail contract, in this order.
    expect(container.querySelector("[data-run-detail-contract]")!.children.length).toBe(2);
    expect(detail.contains(row)).toBe(true);
    expect(rail.contains(row)).toBe(false);
    // The rail ENTRY stays a row: the entry is in the rail, its surface is not.
    const entry = recommendationRow(container)!;
    expect(rail.contains(entry)).toBe(true);
    expect(entry.contains(row)).toBe(false);
    expect(entry.getAttribute("data-recommendation-step-selected")).toBe("true");
    expect(entry.getAttribute("data-recommendation-step-settled")).toBe("false");
  });

  it("sits at the TRIGGER POSITION — the top entry, ahead of the steps it would authorize", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = renderRunSurface({ initialSelection: "recommendation" });

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    const rail = railColumn(container);
    const rows = Array.from(
      rail.querySelectorAll(
        '[data-conformance-id="recommendation-rail-step"], [data-conformance-id="schedule-rail-step"], [data-testid="review-row"]',
      ),
    );
    expect(rows.map((r) => r.getAttribute("data-conformance-id") ?? r.getAttribute("data-testid"))).toEqual([
      "recommendation-rail-step",
      "schedule-rail-step",
      "review-row",
    ]);
    // …and it takes NO numeral (cinatra#3047, the re-shoot's third defect): the
    // drawing gives this entry its own glyph on the open reading and starts the
    // numerals on the step after it, so the schedule below reads "1" rather than
    // being renumbered behind a Skills entry that took the first slot.
    const indicator = rail.querySelector(
      '[data-conformance-id="recommendation-rail-indicator"]',
    )!;
    expect(indicator.textContent?.trim()).toBe("");
    expect(
      indicator.querySelector('[data-conformance-id="recommendation-rail-glyph"]'),
    ).not.toBeNull();
    expect(
      rail.querySelector('[data-conformance-id="schedule-rail-indicator"]')!.textContent,
    ).toBe("1");
  });

  it("draws NO agentic run progress beside it — the selected step is what the detail shows", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = renderRunSurface({ initialSelection: "recommendation" });

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    expect(container.textContent).not.toContain("Agentic Run Progress");
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
    // Exactly one chip row is drawn on this host, ever.
    expect(container.querySelectorAll("[data-run-recommendation-chip-row]").length).toBe(1);
  });
});

describe("a DECIDED hold — the settled reading in the rail, the run detail restored", () => {
  it("keeps the entry as the resolved-gate history row and shows the run's own detail", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = renderRunSurface({ settled: true, initialSelection: "detail" });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    const entry = recommendationRow(container)!;
    expect(entry.getAttribute("data-recommendation-step-settled")).toBe("true");
    expect(entry.getAttribute("data-recommendation-step-selected")).toBe("false");
    // The rail's own completed reading — the numeral is replaced, no status word
    // is added beside the title.
    expect(
      entry.querySelector('[data-conformance-id="recommendation-rail-indicator"]')!.textContent,
    ).toBe("");
    expect(entry.textContent).toBe("Skills");
    // The run detail is what the run page otherwise shows…
    expect(container.textContent).toContain("Agentic Run Progress");
    // …and the settled row is NOT drawn above it (cinatra#3047, review point D).
    // It is the Skills step's own page; the next test opens it.
    expect(chipRow(container)).toBeNull();
    expect(detailColumn(container).querySelectorAll("[data-recommendation-chip]")).toHaveLength(0);
  });

  it("re-opens the settled reading in the same place when its step is selected", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = renderRunSurface({ settled: true, initialSelection: "detail" });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull(),
    );
    await waitFor(() => expect(chipRow(container)).not.toBeNull());
    expect(detailColumn(container).contains(chipRow(container)!)).toBe(true);
    expect(container.querySelectorAll("[data-run-recommendation-chip-row]").length).toBe(1);

    fireEvent.click(container.querySelector('[data-testid="review-row"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );
  });
});

// ---------------------------------------------------------------------------
// THE BRANCH WHOSE PANEL DREW THE CARD IS GONE (cinatra#2790 S9f — R6, closed
// out by cinatra#3047).
//
// This file used to carry a second fixture family for it: a run surface whose
// recommendation step opened NO surface of its own, because `AgenticRunPanel`
// mounted the card inside its own box and a step must never open onto a card
// another module draws. That is exactly the two-placement defect #3047 reports —
// the row sat beside the rail at the schedule moment and inside the run-progress
// panel at the HITL, working and review moments — and the panel's mount is
// deleted: the screen owns the row on EVERY branch, so every branch is the
// branch this file's first two fixtures already model.
//
// What that family proved travels to `run-page-recommendation-one-place.test.tsx`,
// which drives all four `runDetailPanelKind` branches with the REAL panel in the
// run detail and counts the roots.
// ---------------------------------------------------------------------------

describe("the server's answer wins when it changes — the refresh after a decision", () => {
  it("moves the open step when the screen recomputes it, without a remount", async () => {
    // The decision taken IN the card calls `router.refresh()`: the server tree
    // re-renders and this client frame does NOT remount. A selection kept only
    // from the first paint would leave the reader parked on the gate they just
    // settled.
    holdStateMock.mockImplementation(async () => HELD);
    const { container, rerender } = renderRunSurface({ initialSelection: "recommendation" });
    await waitFor(() => expect(chipRow(container)).not.toBeNull());
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();

    holdStateMock.mockImplementation(async () => DECIDED);
    rerender(surface({ settled: true, initialSelection: "detail" }));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );
    expect(
      recommendationRow(container)!.getAttribute("data-recommendation-step-settled"),
    ).toBe("true");
  });

  it("leaves the READER's own selection alone when the server's answer has not moved", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container, rerender } = renderRunSurface({ settled: true, initialSelection: "detail" });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull(),
    );

    // A re-render carrying the SAME server answer must not yank the reader back.
    rerender(surface({ settled: true, initialSelection: "detail" }));
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
  });
});

describe("a run that never held — the rail is unchanged", () => {
  it("draws no recommendation entry at all, and the schedule keeps its own numeral", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = renderRunSurface({
      hasRecommendationStep: false,
      initialSelection: "schedule",
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="schedule-surface"]')).not.toBeNull(),
    );

    expect(recommendationRow(container)).toBeNull();
    expect(container.querySelector('[data-action="open-recommendation-step"]')).toBeNull();
    const rail = railColumn(container);
    expect(
      rail.querySelector('[data-conformance-id="schedule-rail-indicator"]')!.textContent,
    ).toBe("1");
    expect(chipRow(container)).toBeNull();
  });
});
