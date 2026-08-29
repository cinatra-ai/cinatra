// @vitest-environment jsdom
//
// THE REVIEW PAGE'S TWO STEPS SHARE ONE REGION (cinatra#2788, epic #2784 S9d
// rework).
//
// Plan (A) §7.2 step 5: "On the run page and the review page the schedule is a
// **dedicated step in the step rail on the left, above '1 Review'**: open that
// step to see the configuration or change it — it opens to the right of the
// steps, never directly under a step … The schedule is never drawn as a card
// among the review cards — a trigger decides *when* the agent runs, and a review
// card exists only after the agent has run and produced something — so the two
// can never appear together."
//
// So on this page the rail has two selectable steps and ONE region beside it:
// the Review row shows the review card there, the Schedule row shows the
// schedule form there, and neither can be on the screen while the other is. That
// is what this suite reads out of real DOM.
//
// WHAT IT DRIVES MOVED ONE MODULE (cinatra#3047). It drove `ScheduleRailStep`,
// the one-step frame, because the schedule was this page's only gate step. The
// page grew a second — the Skills question, at the head of the rail, where the
// drawing puts it — so it composes the shared frame through
// `ReviewRunSurface`, and this suite drives THAT, with the real rail
// (`ReviewRunSteps`) beside it. Every claim below is unchanged and is made about
// a run with NO recommendation, which is the run this file has always been
// about: the schedule step and the review card, and never both.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// THE SKILLS STEP'S CARD IS NOT THIS FILE'S SUBJECT, and its real module reaches
// the generated extension registry — a graph this suite has no reason to load
// and, on a checkout without the connector fleet, cannot. Every run driven below
// has NO recommendation, so the marker is never rendered; it exists so the
// composition module can be imported at all.
vi.mock("@cinatra-ai/agents/run-recommendation-chip-row", () => ({
  RecommendationHoldCard: () => <div data-run-recommendation-chip-row="" />,
}));

import { ReviewRunSteps } from "../review-run-steps";
import { ReviewRunSurface } from "../review-run-surface";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SETTLED = {
  phase: "settled" as const,
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-777",
  schedule: {
    kind: "recurring" as const,
    timezone: "Europe/Berlin",
    selection: {
      frequency: "weekly" as const,
      interval: 1,
      weekdays: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
      monthlyMode: "date" as const,
      nthWeek: 1,
      monthlyWeekday: 1,
      quarterAnchor: "start" as const,
      yearlyMonth: 1,
      hour: 9,
      minute: 0,
    },
  },
  triggerType: "recurring" as const,
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  arming: false,
  canSave: true,
  canCancel: true,
};

function mockResolve() {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          // A settled state carries no decision axis — the union is strict.
          state: { state: "settled" },
          body: SETTLED,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

/** The page's composition: the rail on the left, the gate region on the right,
 *  and the schedule step owning both columns when the run carries a schedule. */
function renderSurface() {
  return render(
    <div className="flex items-start gap-6" data-run-detail-contract="">
      <ReviewRunSurface
        runId="run-777"
        // A run with no recommendation: the schedule is this page's only gate
        // step, which is the composition every claim below is about.
        recommendationEntry="none"
        recommendationStepOpens={false}
        scheduleCardRef="schedule-ref-1"
        rail={
          <ReviewRunSteps
            steps={[{ index: 1, label: "Review" }]}
            activeStep={1}
            scheduleCardRef="schedule-ref-1"
          />
        }
        detail={<div data-testid="review-gate-card" data-lifecycle-card="artifact_review_gate" />}
      />
    </div>,
  );
}

const scheduleForm = (c: HTMLElement) =>
  c.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
const reviewCard = (c: HTMLElement) => c.querySelector('[data-testid="review-gate-card"]');

describe("the schedule step and the review card never appear together", () => {
  it("opens on the review card — the reviewer came here to decide it", () => {
    mockResolve();
    const { container } = renderSurface();

    expect(reviewCard(container)).not.toBeNull();
    expect(scheduleForm(container)).toBeNull();
    // The rail still LISTS the schedule step, above the Review row.
    const rail = container.querySelector("[data-run-step-rail-column]")!;
    const rows = rail.querySelectorAll(
      '[data-conformance-id="schedule-rail-step"], [data-slot="stepper-item"]',
    );
    expect(rows.length).toBe(2);
    expect(rows[0].getAttribute("data-conformance-id")).toBe("schedule-rail-step");
  });

  it("selecting the schedule entry shows the form — in the region, and not the review card", async () => {
    mockResolve();
    const { container } = renderSurface();

    fireEvent.click(container.querySelector('[data-action="open-schedule-step"]')!);
    await waitFor(() => expect(scheduleForm(container)).not.toBeNull());

    expect(reviewCard(container)).toBeNull();
    const detail = container.querySelector("[data-run-detail-column]")!;
    const rail = container.querySelector("[data-run-step-rail-column]")!;
    expect(detail.contains(scheduleForm(container)!)).toBe(true);
    expect(rail.contains(scheduleForm(container)!)).toBe(false);
  });

  it("selecting the review entry brings the card back and takes the form away", async () => {
    mockResolve();
    const { container } = renderSurface();

    fireEvent.click(container.querySelector('[data-action="open-schedule-step"]')!);
    await waitFor(() => expect(scheduleForm(container)).not.toBeNull());

    fireEvent.click(container.querySelector('[data-action="open-review-step"]')!);
    await waitFor(() => expect(reviewCard(container)).not.toBeNull());
    expect(scheduleForm(container)).toBeNull();
  });

  it("a run with NO schedule keeps the rail inert — no selection to make", () => {
    const { container } = render(
      <ReviewRunSteps steps={[{ index: 1, label: "Review" }]} activeStep={1} />,
    );
    expect(container.querySelector('[data-action="open-review-step"]')).toBeNull();
    expect(container.querySelector('[data-conformance-id="schedule-rail-step"]')).toBeNull();
  });
});
