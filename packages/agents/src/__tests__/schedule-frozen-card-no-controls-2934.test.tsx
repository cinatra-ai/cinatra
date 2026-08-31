// @vitest-environment jsdom
//
// A SPENT SCHEDULE IS A READING, NOT A FORM (cinatra#2934, the FIFTH graded
// proof set).
//
// The ratified drawing at the pin this pull request records gives the fired
// one-off exactly one reading: "Once it has fired, the card is a reading. A
// one-off that has fired cannot be changed, so the rows go read-only — the
// values still legible, the pickers gone — and the card carries no floor at
// all: no hairline, no button, nothing to press." Its own state table says the
// same in one line: "Fired, one-off — the schedule was spent | read-only |
// none at all", and the schedule entry of a spent one-off "shows the form
// read-only, with no controls at all".
//
// WHAT WAS WRONG, AND IT IS NOT A COLOUR. The frozen card kept every control it
// had and merely DISABLED it: the option rows stayed real buttons and the
// chosen row kept real pickers, greyed. That is the drawing's OTHER reading —
// the restricted reader, who "may see but not act on" the card and gets it
// "drawn in full with its buttons disabled and the reason on the card". Two
// different states may not draw the same DOM, and the drawing separates them by
// the PRESENCE of controls, not by their opacity: measured against the drawing,
// a fired row is a plain row (cursor default, nothing to press) whose values
// are legible text, while the restricted row is a live control that is dead.
//
// So this file pins the DIFFERENCE, in both directions:
//   1. a frozen card (a fired immediate, a fired one-off, a stopped recurring)
//      has NO control element anywhere in its rows — no button, no input, no
//      select, no textarea;
//   2. its armed values stay legible as text — "the values still legible";
//   3. a RESTRICTED reader's card, which is NOT frozen, still draws its
//      controls, disabled, because that reader is owed the withheld control and
//      the reason beside it.
//
// Pure render, no DB, no session.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "run-scoped-ref",
};

const PAST_ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2020-03-04T09:00",
  timezone: "Europe/Berlin",
};

const RECURRING: ProposedSchedule = {
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
};

function settled(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>>,
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Q3 cohort sweep",
    runId: "run-777",
    schedule: RECURRING,
    triggerType: "recurring",
    scheduleCopy: "Every weekday at 9:00 AM",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    canCancel: false,
    ...over,
  };
}

/** The three bodies the resolver produces for a schedule that is OVER. */
const FROZEN = {
  "Run right after setup, fired": settled({
    triggerType: "immediate",
    schedule: { kind: "immediate" },
    scheduleCopy: "Runs right after setup",
    released: true,
    canSave: false,
    canCancel: false,
  }),
  "Schedule for later, fired": settled({
    triggerType: "scheduled",
    schedule: PAST_ONE_OFF,
    scheduleCopy: "Once, at 2020-03-04 09:00",
    released: true,
    canSave: false,
    canCancel: false,
  }),
  "Recurring, stopped": settled({ canSave: false, canCancel: false, stopped: true }),
} as const;

/** NOT frozen: the reader may see the card and not act on it. The server sends
 *  the sentence for exactly this case, and the drawing keeps the controls. */
const RESTRICTED = settled({
  canSave: false,
  canCancel: false,
  saveRefusal: "Changing this schedule needs run access on it.",
});

function mount(body: TriggerScheduleProposalViewBody) {
  const state: LifecycleCardState = { state: "settled" };
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "trigger_schedule_proposal", state, body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

const rows = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-option-rows"]') as HTMLElement | null;

const CONTROLS = "button, input, select, textarea, [role='button'], [role='combobox']";

describe("the rows read-only, no floor — a spent schedule carries no controls at all", () => {
  for (const [name, body] of Object.entries(FROZEN)) {
    it(`${name}: the rows hold NO control element — the pickers gone`, async () => {
      const { container } = mount(body);
      await waitFor(() => expect(rows(container)).not.toBeNull());
      const found = Array.from(rows(container)!.querySelectorAll(CONTROLS)).map((el) => {
        const field = el.getAttribute("data-field");
        return field ? `${el.tagName.toLowerCase()}[${field}]` : el.tagName.toLowerCase();
      });
      expect(found, `${name} still offers controls`).toEqual([]);
    });
  }

  it("the values still legible — a fired one-off shows the moment it was armed for", async () => {
    const { container } = mount(FROZEN["Schedule for later, fired"]);
    await waitFor(() => expect(rows(container)).not.toBeNull());
    const text = rows(container)!.textContent ?? "";
    expect(text).toContain("Schedule for later");
    expect(text).toContain("2020-03-04T09:00");
    expect(text).toContain("Europe/Berlin");
  });

  it("the values still legible — a stopped recurring still shows what it ran on", async () => {
    const { container } = mount(FROZEN["Recurring, stopped"]);
    await waitFor(() => expect(rows(container)).not.toBeNull());
    const text = rows(container)!.textContent ?? "";
    expect(text).toContain("Recurring");
    expect(text).toContain("Europe/Berlin");
  });
});

describe("the OTHER reading is not collapsed into it — a restricted reader keeps the dead controls", () => {
  it("draws the card in full with its controls present and disabled", async () => {
    const { container } = mount(RESTRICTED);
    await waitFor(() => expect(rows(container)).not.toBeNull());
    const controls = Array.from(rows(container)!.querySelectorAll("button, input"));
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(
        el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
        `${el.tagName.toLowerCase()} was live for a reader who may not act`,
      ).toBe(true);
    }
  });
});
