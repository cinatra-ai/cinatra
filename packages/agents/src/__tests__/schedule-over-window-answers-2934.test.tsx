// @vitest-environment jsdom
//
// A SCHEDULE THAT CAN NO LONGER BE CHANGED **ANSWERS** (cinatra#2934, the
// armed-schedule change road) — plan (A) §7.2, and the reversal of this pull
// request's own named deviation.
//
// WHAT THE DEVIATION SAID, and why it is withdrawn. cinatra#3004 read "a
// control that exists only to refuse" as a reason to draw NOTHING for a
// schedule that is over: the card dropped its whole controls floor and the
// surfaces, which measure the window's state off that floor, dropped the window
// with it. The graded re-shoot photographed the result: a fired one-off with
// its rows locked, no floor, no window, no composer and NO SENTENCE ANYWHERE —
// the reader is told nothing rather than told why.
//
// WHAT THE PLAN ASKS FOR INSTEAD. §7.2: "once a run set to Run right after
// setup or Schedule for later has fired, its schedule cannot be changed any
// more" — and the reading a reader is owed for a surface they may see but not
// act on is the surface WHOLE, with its actions disabled and the reason on
// screen. So: the form stays locked, the floor STAYS and is drawn dead, the
// server's own sentence for that state is on it, and the window stays and says
// the same thing in its own words rather than vanishing.
//
// THE COMPOSER IS STILL WITHDRAWN, and that half of #3004 stands: an invitation
// to type a change is one this surface cannot keep. What replaces it is an
// answer, not an empty column.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/schedule-over-window-answers-2934.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { RunScheduleTab } from "../run-schedule-tab";
import { ScheduleStepSurface } from "../schedule-rail-step";
import { SCHEDULE_WINDOW_OVER_NOTICE } from "../schedule-prompt-window";
import { SAVE_SCHEDULE_REFUSALS } from "../trigger-recurrence";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEMPLATE = "tpl-2934";

const LIVE_RECURRING: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-2934",
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

const FIRED_ONE_OFF: TriggerScheduleProposalViewBody = {
  ...LIVE_RECURRING,
  schedule: { kind: "scheduled", runAt: "2026-08-24T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "On 24 August 2026 at 9:00 AM",
  released: true,
  canSave: false,
  canCancel: false,
};

const STOPPED_RECURRING: TriggerScheduleProposalViewBody = {
  ...LIVE_RECURRING,
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

const floor = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-proposal-floor"]');
const saveButton = (root: HTMLElement) =>
  root.querySelector('[data-action="save-schedule-changes"]') as HTMLButtonElement | null;
/** The box a person types in — the panel's own field, not its mount. */
const composer = (root: HTMLElement) =>
  root.querySelector('[data-schedule-prompt-window=""] [contenteditable="true"]');
const windowAnswer = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-window-over"]');

describe("a fired one-off answers instead of withdrawing", () => {
  it("keeps the floor, draws Save changes dead, and puts the reason on screen", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floor(container)).toBeTruthy());
    expect(floor(container)!.getAttribute("data-schedule-changeable")).toBe("false");
    expect(saveButton(container)).toBeTruthy();
    expect(saveButton(container)!.disabled).toBe(true);
    expect(container.textContent).toContain(SAVE_SCHEDULE_REFUSALS.firedOneOff);
  });

  it("keeps the window, which says the schedule can no longer be changed", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(windowAnswer(container)).toBeTruthy());
    expect(windowAnswer(container)!.textContent).toBe(SCHEDULE_WINDOW_OVER_NOTICE);
    // The invitation to type is still withdrawn — an answer, not a dead box.
    expect(composer(container)).toBeNull();
  });

  it("the run page's schedule step reads it exactly the same way", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <ScheduleStepSurface host="run_card" cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(windowAnswer(container)).toBeTruthy());
    expect(floor(container)!.getAttribute("data-schedule-changeable")).toBe("false");
    expect(container.textContent).toContain(SAVE_SCHEDULE_REFUSALS.firedOneOff);
    expect(composer(container)).toBeNull();
  });
});

describe("a recurring schedule stopped after a fire answers with its own reason", () => {
  it("names the stop, not the release", async () => {
    mockResolve(STOPPED_RECURRING);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floor(container)).toBeTruthy());
    expect(container.textContent).toContain(SAVE_SCHEDULE_REFUSALS.stopped);
    expect(container.textContent).not.toContain(SAVE_SCHEDULE_REFUSALS.firedOneOff);
    expect(windowAnswer(container)).toBeTruthy();
  });
});

describe("a schedule that can still be changed is untouched by any of this", () => {
  it("draws a live floor, no over-notice, and a composer to type in", async () => {
    mockResolve(LIVE_RECURRING);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floor(container)).toBeTruthy());
    expect(floor(container)!.getAttribute("data-schedule-changeable")).toBe("true");
    expect(windowAnswer(container)).toBeNull();
    await waitFor(() => expect(composer(container)).toBeTruthy());
    expect(container.textContent).not.toContain(SAVE_SCHEDULE_REFUSALS.firedOneOff);
  });
});
