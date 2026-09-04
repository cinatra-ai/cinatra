// @vitest-environment jsdom
//
// THE REVIEW PAGE CARRIES THE REVIEW CARD ALONE, AND THE SKILLS STEP HEADS ITS
// RAIL (cinatra#3047, the re-shoot's first and second defects).
//
// The change request's point D, in its own words: "Every HITL shows on its own
// dedicated page. Do not show skills on top of a HITL card. Do not show the
// skills on top of the review card or the schedule card or any other card
// either." The ratified drawing at the capture contract's pin says the same in
// its own vocabulary — "one page per gate" — and draws the review page's rail
// with the Skills entry FIRST, as read-only history, above the run's steps and
// the gated Review row.
//
// WHAT THE RE-SHOOT PHOTOGRAPHED, and what this suite therefore reads. The run
// page's own surfaces passed: zero `[data-run-recommendation-chip-row]` in the
// detail column at the HITL and schedule moments. The REVIEW page failed both
// halves at once, because the review route is a SECOND composition of the same
// run and no earlier leg of this change touched it: the card was mounted
// straight into the gate region above the review card, and the rail read
// "1 Schedule / 2 Review" with no Skills entry at all.
//
// So this suite drives the page's REAL composition — `ReviewRunSurface`, the one
// module the page hands its facts to — with the same two collaborators the page
// composes around it: the real rail (`ReviewRunSteps`) and the real Skills row.
// The recommendation CARD is stubbed to a marker carrying the row's own root
// anchor: what is measured here is WHERE the row lands and how many of it there
// are, which is a fact about the composition. WHAT it draws on this host is read
// off the real card in `packages/agents/src/__tests__/skills-step-on-the-review-
// page.test.tsx`.
//
// Run:
//   npx vitest run "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/__tests__/review-page-skills-step.test.tsx"
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// The row's ROOT ANCHOR and nothing else — the same attribute the live DOM
// readings in the re-shoot counted, so a count here and a count on a photograph
// are the same measurement.
vi.mock("@cinatra-ai/agents/run-recommendation-chip-row", () => ({
  RecommendationHoldCard: ({ runId }: { runId: string }) => (
    <div data-run-recommendation-chip-row="" data-testid="chip-row" data-run-id={runId} />
  ),
}));

vi.mock("@cinatra-ai/agents/schedule-proposal-card", () => ({
  ScheduleProposalCard: () => <div data-lifecycle-card="trigger_schedule_proposal" />,
}));

import { ReviewRunSurface } from "../review-run-surface";
import { ReviewRunSteps } from "../review-run-steps";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REVIEW_CARD = <div data-testid="review-gate-card" data-lifecycle-card="artifact_review_gate" />;

function renderSurface(opts: {
  entry: "none" | "live" | "settled";
  opens?: boolean;
  scheduleCardRef?: string | null;
  steps?: { index: number; label: string }[];
}) {
  const steps = opts.steps ?? [{ index: 1, label: "Review" }];
  return render(
    <div className="flex items-start gap-6" data-run-detail-contract="">
      <ReviewRunSurface
        runId="run-3047"
        recommendationEntry={opts.entry}
        recommendationStepOpens={opts.opens ?? true}
        scheduleCardRef={opts.scheduleCardRef ?? null}
        rail={
          <ReviewRunSteps
            steps={steps}
            activeStep={steps[steps.length - 1]!.index}
            scheduleCardRef={opts.scheduleCardRef ?? null}
          />
        }
        detail={REVIEW_CARD}
      />
    </div>,
  );
}

const chipRows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("[data-run-recommendation-chip-row]"));
const detailColumn = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-detail-column]")!;
const railColumn = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-step-rail-column]")!;
const reviewCard = (c: HTMLElement) => c.querySelector('[data-testid="review-gate-card"]');

describe("defect 1 — the review page's detail column carries the review card alone", () => {
  it("draws ZERO skills rows above the review card on a settled run", () => {
    const { container } = renderSurface({ entry: "settled" });

    expect(reviewCard(container)).not.toBeNull();
    // The measurement the re-shoot took off the live DOM: one row inside the
    // detail column. It must be none.
    expect(detailColumn(container).querySelectorAll("[data-run-recommendation-chip-row]")).toHaveLength(0);
    expect(chipRows(container)).toHaveLength(0);
  });

  it("draws ZERO skills rows above the review card while the hold is still live", () => {
    const { container } = renderSurface({ entry: "live" });
    expect(reviewCard(container)).not.toBeNull();
    expect(chipRows(container)).toHaveLength(0);
  });

  it("draws ZERO skills rows above the review card when the run also carries a schedule", () => {
    const { container } = renderSurface({ entry: "settled", scheduleCardRef: "sched-1" });
    expect(reviewCard(container)).not.toBeNull();
    expect(chipRows(container)).toHaveLength(0);
  });

  it("opens the row on the Skills step, in the detail column, and takes the review card away", async () => {
    const { container } = renderSurface({ entry: "settled" });

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(chipRows(container)).toHaveLength(1));

    // ONE row, and it is in the detail column rather than stacked above
    // anything: the review card is not on screen with it.
    expect(detailColumn(container).contains(chipRows(container)[0]!)).toBe(true);
    expect(railColumn(container).contains(chipRows(container)[0]!)).toBe(false);
    expect(reviewCard(container)).toBeNull();
  });

  it("brings the review card back — and the row goes with it", async () => {
    const { container } = renderSurface({ entry: "settled" });
    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(chipRows(container)).toHaveLength(1));

    fireEvent.click(container.querySelector('[data-action="open-review-step"]')!);
    await waitFor(() => expect(reviewCard(container)).not.toBeNull());
    expect(chipRows(container)).toHaveLength(0);
  });
});

describe("defect 2 — the Skills entry is the FIRST row of the review page's rail", () => {
  it("heads the rail on a run that had a recommendation", () => {
    const { container } = renderSurface({ entry: "settled", scheduleCardRef: "sched-1" });
    const rows = Array.from(
      railColumn(container).querySelectorAll<HTMLElement>(
        '[data-conformance-id="recommendation-rail-step"], [data-conformance-id="schedule-rail-step"], [data-slot="stepper-item"]',
      ),
    );
    expect(rows[0]!.getAttribute("data-conformance-id")).toBe("recommendation-rail-step");
    expect(rows[1]!.getAttribute("data-conformance-id")).toBe("schedule-rail-step");
  });

  it("heads the rail with no schedule step beside it either", () => {
    const { container } = renderSurface({ entry: "settled" });
    const rows = Array.from(
      railColumn(container).querySelectorAll<HTMLElement>(
        '[data-conformance-id="recommendation-rail-step"], [data-slot="stepper-item"]',
      ),
    );
    expect(rows[0]!.getAttribute("data-conformance-id")).toBe("recommendation-rail-step");
  });

  it("reads SETTLED on a run whose question was answered — read-only history", () => {
    const { container } = renderSurface({ entry: "settled" });
    const row = container.querySelector('[data-conformance-id="recommendation-rail-step"]')!;
    expect(row.getAttribute("data-recommendation-step-settled")).toBe("true");
  });

  it("draws no Skills entry for a run that never held — nothing is invented", () => {
    const { container } = renderSurface({ entry: "none", scheduleCardRef: "sched-1" });
    expect(container.querySelector('[data-conformance-id="recommendation-rail-step"]')).toBeNull();
    // And the page is unchanged for such a run: the schedule step still heads
    // the rail and the review card is still what the page opens on.
    expect(container.querySelector('[data-conformance-id="schedule-rail-step"]')).not.toBeNull();
    expect(reviewCard(container)).not.toBeNull();
  });

  it("keeps the rail inert for a run with no gate step at all", () => {
    const { container } = renderSurface({ entry: "none" });
    expect(container.querySelector('[data-conformance-id="recommendation-rail-step"]')).toBeNull();
    expect(container.querySelector('[data-conformance-id="schedule-rail-step"]')).toBeNull();
    expect(reviewCard(container)).not.toBeNull();
  });
});

describe("defect 3 on this rail — the Skills entry takes no numeral", () => {
  it("leaves the Review row reading 1 when the Skills entry is the only gate step", () => {
    const { container } = renderSurface({ entry: "settled" });
    const indicator = container.querySelector('[data-slot="stepper-indicator"]')!;
    expect(indicator.textContent?.trim()).toBe("1");
  });

  it("still reads 2 with a Schedule step above it — the schedule keeps its numeral", () => {
    const { container } = renderSurface({ entry: "settled", scheduleCardRef: "sched-1" });
    const scheduleIndicator = container.querySelector(
      '[data-conformance-id="schedule-rail-indicator"]',
    )!;
    expect(scheduleIndicator.textContent?.trim()).toBe("1");
    const reviewIndicator = container.querySelector('[data-slot="stepper-indicator"]')!;
    expect(reviewIndicator.textContent?.trim()).toBe("2");
  });
});
