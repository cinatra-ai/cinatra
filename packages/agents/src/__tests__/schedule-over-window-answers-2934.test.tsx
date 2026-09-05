// @vitest-environment jsdom
//
// A SCHEDULE THAT CAN NO LONGER BE CHANGED IS DRAWN AS THE DRAWING DRAWS IT
// (cinatra#2934, the FOURTH graded capture of this pull request).
//
// THE READING THIS SUITE USED TO PIN, and why it is withdrawn. The third fix leg
// read plan (A) §7.2's "answer that it can no longer be changed" as a reason to
// keep the card's controls floor and draw it DEAD — Save changes present and
// disabled, the server's own state sentence beside it inside the form. The
// fourth capture graded that against the ratified drawing at the pin this pull
// request records and against §7.2's own words, and both refuse it: the drawing
// gives a fired card NO FLOOR AT ALL — no hairline, no button, nothing to press
// — and §7.2 says the schedule surface "shows the same form and nothing else —
// no summary box, no status label". One drawing conflict was traded for another.
//
// WHAT IS DRAWN INSTEAD, and it is the whole of it:
//
//   · the form, locked, and nothing else on the card — no floor, no button, no
//     status line;
//   · the prompt window below the scheduler, PRESENT and disabled, drawn as the
//     window's own block — its chrome and its bordered field — carrying the
//     answer that the schedule can no longer be changed. The answer lives in
//     that block; it is never loose paragraph text on the page ground, which is
//     what the capture photographed and called a paragraph rather than a window.
//
// AND THE WINDOW'S OWN INVITATION is the drawing's copy again (§7.4 step 8).
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
import { RUN_WINDOW_PLACEHOLDERS } from "../hitl-conversation-panel";
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

/** A schedule that is perfectly changeable, viewed by somebody who may not
 *  change it (plan (A) §1.2: "the card is drawn in full with its buttons
 *  disabled and the reason on the card"). */
const NOT_THIS_PERSONS: TriggerScheduleProposalViewBody = {
  ...LIVE_RECURRING,
  canSave: false,
  canCancel: false,
  saveRefusal: SAVE_SCHEDULE_REFUSALS.notYours,
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

const card = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-proposal-card"]');
const floor = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-proposal-floor"]');
const saveButton = (root: HTMLElement) =>
  root.querySelector('[data-action="save-schedule-changes"]') as HTMLButtonElement | null;
/** The box a person types in — the panel's own field, not its mount. */
const composer = (root: HTMLElement) =>
  root.querySelector('[data-schedule-prompt-window=""] [contenteditable="true"]');
const windowMount = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-prompt-window"]');
/** The window's OWN block — the same chrome the live window draws. */
const windowBlock = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-prompt-window"] [data-run-window-placement]');
/** The window's bordered field, disabled, carrying the answer. */
const windowField = (root: HTMLElement) =>
  root.querySelector('[data-run-window-field]');
const windowAnswer = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-window-over"]');

describe("a fired one-off carries no floor at all", () => {
  it("draws the locked form and nothing else — no floor, no button, no status line", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(card(container)).toBeTruthy());
    expect(floor(container)).toBeNull();
    expect(saveButton(container)).toBeNull();
    // NO STATUS LABEL INSIDE THE FORM (§7.2). The state's own sentence belongs
    // to the window below, and it is drawn there exactly once.
    expect(card(container)!.textContent).not.toContain(SAVE_SCHEDULE_REFUSALS.firedOneOff);
  });

  it("keeps the window, present and disabled, drawn as the window's own block", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(windowAnswer(container)).toBeTruthy());
    // THE WINDOW'S OWN CHROME, not a paragraph on the page ground.
    expect(windowMount(container)).toBeTruthy();
    expect(windowBlock(container)).toBeTruthy();
    const field = windowField(container);
    expect(field).toBeTruthy();
    expect(field!.getAttribute("aria-disabled")).toBe("true");
    // AND THE ANSWER LIVES INSIDE THAT FIELD.
    expect(field!.contains(windowAnswer(container))).toBe(true);
    expect(windowAnswer(container)!.textContent).toBe(SCHEDULE_WINDOW_OVER_NOTICE);
    // Nothing can be typed into it.
    expect(composer(container)).toBeNull();
  });

  it("the run page's schedule step reads it exactly the same way", async () => {
    mockResolve(FIRED_ONE_OFF);
    const { container } = render(
      <ScheduleStepSurface host="run_card" cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(windowAnswer(container)).toBeTruthy());
    expect(floor(container)).toBeNull();
    expect(windowField(container)).toBeTruthy();
    expect(composer(container)).toBeNull();
  });
});

describe("a recurring schedule stopped after a fire is drawn the same way", () => {
  it("carries no floor, and the window says it in the window's own block", async () => {
    mockResolve(STOPPED_RECURRING);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(windowAnswer(container)).toBeTruthy());
    expect(floor(container)).toBeNull();
    expect(card(container)!.textContent).not.toContain(SAVE_SCHEDULE_REFUSALS.stopped);
    expect(windowField(container)!.contains(windowAnswer(container))).toBe(true);
  });
});

describe("a schedule that can still be changed is untouched by any of this", () => {
  it("draws a live floor, no over-notice, and a composer to type in", async () => {
    mockResolve(LIVE_RECURRING);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floor(container)).toBeTruthy());
    expect(windowAnswer(container)).toBeNull();
    await waitFor(() => expect(composer(container)).toBeTruthy());
    expect(container.textContent).not.toContain(SAVE_SCHEDULE_REFUSALS.firedOneOff);
  });

  it("invites the reader in the drawing's own words", () => {
    // Plan (A) §7.4 step 8, word for word.
    expect(RUN_WINDOW_PLACEHOLDERS["armed-trigger"]).toBe(
      "Ask Cinatra to suggest edits to the fields above…",
    );
  });
});

describe("a card this person may see but not act on", () => {
  it("keeps the floor whole, draws Save changes dead, and puts the reason on it", async () => {
    mockResolve(NOT_THIS_PERSONS);
    const { container } = render(
      <RunScheduleTab cardRef="run-ref" promptWindowTemplateId={TEMPLATE} />,
    );
    await waitFor(() => expect(floor(container)).toBeTruthy());
    // The card is drawn IN FULL — this schedule is not over, and saying so
    // would be as false as the sentence the fourth capture caught.
    expect(saveButton(container)).toBeTruthy();
    expect(saveButton(container)!.disabled).toBe(true);
    expect(floor(container)!.textContent).toContain(SAVE_SCHEDULE_REFUSALS.notYours);
    expect(windowAnswer(container)).toBeNull();
    // And the window stays live, because the true reason has to be answerable.
    await waitFor(() => expect(composer(container)).toBeTruthy());
  });
});
