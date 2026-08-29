// @vitest-environment jsdom
//
// READING 3 OF cinatra#3004's live-proof round — THE COMPOSER FOLLOWS THE FORM.
//
// What the proofs showed: on a one-off that had already fired, the surface drew
// the schedule read-only and then, underneath it, a live composer still asking
// "Ask Cinatra to change this schedule, or ask about it…" (§X's reading for
// this surface). The schedule above could not be changed by anybody, so the
// invitation was one the surface could not keep.
//
// THE RULE, IN THE PLAN'S OWN TERMS. The window belongs "below the scheduler",
// and a scheduler that is over has nothing left to suggest edits to. So the
// composer is present and live exactly while the schedule can still be changed,
// and absent once the run is over.
//
// ABSENT, NOT DISABLED, AND THAT IS THE SHIPPED CONTRACT SPEAKING.
// `HitlConversationPanel` takes one `visible` boolean and has no read-only
// reading of its own. Drawing a dead composer would be the same "control that
// exists only to refuse" the card itself withheld, so the surface withdraws the
// BOX rather than inventing a state the panel does not have.
//
// WHAT IS NO LONGER WITHDRAWN WITH IT (cinatra#2934, and the reason these cases
// moved): the WINDOW. Withdrawing both left a fired one-off with a locked form
// and nothing under it — no box, no sentence, no reason — and plan (A) §7.2
// asks that state to ANSWER that the schedule can no longer be changed. So the
// window stays and says so, the card's floor stays and is drawn dead with the
// server's own reason on it, and only the composer goes. These cases pin the
// composer half; the answering half is pinned in
// `schedule-over-window-answers-2934.test.tsx`.
//
// IT IS MEASURED, NOT PREDICTED, like the "is there a scheduler at all"
// reading beside it: the card resolves after mount and the surface around it
// cannot ask it what it decided, so the honest reading is the DOM it produced —
// its controls floor, which now says on itself whether the schedule can still
// be changed.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/schedule-composer-follows-state-3004.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { RunScheduleTab } from "../run-schedule-tab";
import { ScheduleStepSurface } from "../schedule-rail-step";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEMPLATE = "tpl-3004";

const RECURRING_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-3004",
  schedule: {
    kind: "recurring",
    timezone: "Europe/Berlin",
    selection: {
      frequency: "weekly",
      interval: 1,
      weekdays: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
      monthlyMode: "date",
      nthWeek: 1,
      monthlyWeekday: 1,
      quarterAnchor: "start",
      yearlyMonth: 1,
      hour: 9,
      minute: 0,
    },
  },
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  arming: false,
  canSave: true,
  canCancel: true,
};

/** A one-off that has fired: the card draws the rows and a DEAD floor. */
const FIRED_ONE_OFF: TriggerScheduleProposalViewBody = {
  ...RECURRING_BODY,
  schedule: { kind: "scheduled", runAt: "2026-08-24T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "On 24 August 2026 at 9:00 AM",
  released: true,
  canSave: false,
  canCancel: false,
};

/** A recurring schedule cancelled after a fire: the same ending. */
const STOPPED_RECURRING: TriggerScheduleProposalViewBody = {
  ...RECURRING_BODY,
  stopped: true,
  canSave: false,
  canCancel: false,
};

function mockResolve(body: TriggerScheduleProposalViewBody) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

/** The BOX a person types in — not the window's mount, which now outlives it. */
function composerIsDrawn(root: HTMLElement): boolean {
  return !!root.querySelector(
    '[data-schedule-prompt-window=""] [contenteditable="true"]',
  );
}

/** The card's controls floor, and its OWN answer to "can this still change". */
function floorSaysChangeable(root: HTMLElement): boolean {
  const floor = root.querySelector('[data-conformance-id="schedule-proposal-floor"]');
  return !!floor && floor.getAttribute("data-schedule-changeable") !== "false";
}

describe("the run's schedule surface — the composer follows the form's state", () => {
  it("a live recurring schedule keeps the composer, under a form that can still change", async () => {
    mockResolve(RECURRING_BODY);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floorSaysChangeable(container)).toBe(true));
    await waitFor(() => expect(composerIsDrawn(container)).toBe(true));
  });

  it("a fired one-off draws no composer — the fields above it cannot be edited", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    // The form IS drawn — this is the read-only reading, not an absence.
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).toBeTruthy(),
    );
    expect(floorSaysChangeable(container)).toBe(false);
    expect(composerIsDrawn(container)).toBe(false);
  });

  it("a recurring schedule cancelled after a fire draws no composer either", async () => {
    mockResolve(STOPPED_RECURRING);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).toBeTruthy(),
    );
    expect(floorSaysChangeable(container)).toBe(false);
    expect(composerIsDrawn(container)).toBe(false);
  });
});

describe("the run page's schedule step reads it the same way", () => {
  it("keeps the composer while the schedule can still change", async () => {
    mockResolve(RECURRING_BODY);
    const { container } = render(
      <ScheduleStepSurface host="run_card" cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floorSaysChangeable(container)).toBe(true));
    await waitFor(() => expect(composerIsDrawn(container)).toBe(true));
  });

  it("withdraws it once the run is over", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <ScheduleStepSurface host="run_card" cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).toBeTruthy(),
    );
    expect(composerIsDrawn(container)).toBe(false);
  });
});

