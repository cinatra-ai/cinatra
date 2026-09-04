// @vitest-environment jsdom
//
// THE SETTLED CARD'S THREE READINGS, DRAWN AS SECTION VI DRAWS THEM
// (cinatra#3174, fix leg 1 after the first graded proof round).
//
// THREE SENTENCES THE FIRST ROUND GRADED FALSE OVER THE SAME PICTURE.
//
// 1. "Once it has fired, the card is a reading. A one-off that has fired cannot
//    be changed, so the rows go read-only — the values still legible, the
//    pickers gone — and the card carries no floor at all: no hairline, no
//    button, nothing to press." The graded frame drew live radio rows with
//    every picker still standing; only the floor was gone.
//
// 2. The section's fired-one-off example draws the estimated-duration line as a
//    duration — "Estimated run duration / About 45s – 3.4 hr." — in every one
//    of its five pictures. The graded frame drew the literal "Unavailable.",
//    which is a sentence the drawing never draws anywhere. The scheduling step
//    this card reproduces already answers a missing estimate by drawing NO LINE
//    (its own note: "where the drawing gives nothing, nothing is drawn"), and
//    the card now answers the same way with the same words for the same reason.
//
// 3. The election. "Fired, one-off — the schedule was spent" is the reading the
//    rows go read-only for, and it may not be elected from the gate stamp
//    alone: the graded run had its gate opened and then failed without ever
//    starting. The card reads the durable answer the resolver carries beside
//    the body, and nothing else.
//
// AND ONE THE ROUND NEVER REACHED, pinned so the next round can shoot it:
// "the floor becomes Save changes — quiet until a row is actually changed,
// because there is nothing to save until then."
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-card-readings-per-drawing-3193-fix1.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  DURATION_LINE_NO_ESTIMATE,
  ScheduleProposalCard,
} from "../schedule-proposal-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "fix1-ref",
};

const ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2026-07-14T09:00",
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
    runId: "run-3193-fix1",
    schedule: ONE_OFF,
    triggerType: "scheduled",
    scheduleCopy: "Once, at 2026-07-14 09:00",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    canCancel: false,
    ...over,
  };
}

type Aside = { firedOnce?: boolean; durationCopy?: string | null };

function mount(body: TriggerScheduleProposalViewBody, aside: Aside = {}) {
  const state: LifecycleCardState =
    body.phase === "settled"
      ? { state: "settled" }
      : { state: "pending", canDecide: true, canComment: false };
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state,
          body,
          ...(aside.firedOnce ? { firedOnce: true } : {}),
          ...(aside.durationCopy === undefined ? {} : { durationCopy: aside.durationCopy }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function rowsOf(view: ReturnType<typeof render>): Promise<Element> {
  let rows: Element | null = null;
  await waitFor(() => {
    rows = view.container.querySelector('[data-conformance-id="schedule-option-rows"]');
    expect(rows).not.toBeNull();
  });
  return rows as unknown as Element;
}

/** The FIRED ONE-OFF: the gate opened AND the run ran, so the resolver's answer
 *  carries the fired reading beside the body. */
const FIRED_ONE_OFF = settled({ released: true, canSave: false });

describe("the fired one-off's rows are the record, not a form", () => {
  it("draws no picker at all — no input, no select trigger, no row button", async () => {
    const rows = await rowsOf(mount(FIRED_ONE_OFF, { firedOnce: true }));
    expect(rows.querySelectorAll("input").length).toBe(0);
    expect(rows.querySelectorAll("select").length).toBe(0);
    expect(rows.querySelectorAll("button").length).toBe(0);
    expect(rows.querySelectorAll("[data-field]").length).toBe(0);
  });

  it("keeps the values legible — the schedule is still readable as text", async () => {
    const rows = await rowsOf(mount(FIRED_ONE_OFF, { firedOnce: true }));
    const text = rows.textContent ?? "";
    expect(text).toContain("When should this run?");
    expect(text).toContain("Run right after setup");
    expect(text).toContain("Schedule for later");
    expect(text).toContain("Recurring");
    expect(text).toContain("Europe/Berlin");
    // The moment reads in the reader's own locale, the way the picker drew it —
    // the drawing's own fired example draws "14.07.2026, 09:00", which is that
    // same wall clock in that reader's locale.
    // THE MOMENT, PINNED WHOLE (converge round). The reading is the reader's own
    // locale, so the expectation is built from the SAME wall clock read as LOCAL
    // time — which is what pins the contract that matters: the naive wire value is
    // drawn as itself, never shifted into or out of a zone. Asserting only the year
    // and the hour would pass a formatter that moved the day.
    expect(text).toContain(
      new Date(2026, 6, 14, 9, 0).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
    expect(text).not.toContain("2026-07-14T09:00");
  });

  it("still marks which row the schedule is on, so the reading is unambiguous", async () => {
    const rows = await rowsOf(mount(FIRED_ONE_OFF, { firedOnce: true }));
    expect(
      rows.querySelector('[data-schedule-option="scheduled"]')?.getAttribute("data-chosen"),
    ).toBe("true");
    expect(
      rows.querySelector('[data-schedule-option="recurring"]')?.getAttribute("data-chosen"),
    ).toBe("false");
  });

  it("carries no floor at all — nothing to press", async () => {
    const view = mount(FIRED_ONE_OFF, { firedOnce: true });
    await rowsOf(view);
    expect(
      view.container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
    ).toBeNull();
  });
});

describe("the reading is elected from the run's own record, never from the gate stamp", () => {
  it("a released schedule whose run never ran is CONFIGURED, and keeps its form", async () => {
    // THE GRADED ROW, AS THE SERVER ACTUALLY ANSWERS IT (converge round): the
    // gate opened, the run failed before starting, so the resolver's answer
    // carries no fired reading — and `canSave` is FALSE, because the save guard
    // still refuses a one-off whose gate has opened. The earlier fixture paired
    // `released` with `canSave: true`, which no resolver can produce, and that
    // hid what this reading really draws.
    const view = mount(settled({ released: true, canSave: false, triggerType: "immediate" }));
    const rows = await rowsOf(view);
    expect(
      view.container
        .querySelector('[data-conformance-id="schedule-proposal-card"]')
        ?.getAttribute("data-schedule-reading"),
    ).toBe("configured");
    // The form is still the reading: the rows are drawn, not replaced by the
    // record a spent schedule becomes.
    expect(rows.querySelectorAll("[data-field]").length).toBeGreaterThan(0);
    expect(
      view.container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
    ).not.toBeNull();
  });

  it("and NO status label stands over it — §VI draws none on any reading", async () => {
    // "No summary box is ever drawn, no status label, and nothing stands
    // between the reader and the form — the rows are the reading." The
    // "Released —" line used to be unreachable on this card because the gate
    // stamp froze it; the corrected election reaches it, so the label had to
    // go rather than come back as the section's forbidden one.
    const view = mount(settled({ released: true, canSave: false, triggerType: "immediate" }));
    await rowsOf(view);
    expect(
      view.container.querySelector('[data-conformance-id="schedule-released"]'),
    ).toBeNull();
    expect(view.container.textContent ?? "").not.toContain("Released —");
  });

  it("the same body WITH the fired reading beside it is the spent one-off", async () => {
    const view = mount(settled({ released: true, canSave: false }), { firedOnce: true });
    await rowsOf(view);
    expect(
      view.container
        .querySelector('[data-conformance-id="schedule-proposal-card"]')
        ?.getAttribute("data-schedule-reading"),
    ).toBe("fired-one-off");
  });
});

describe("the estimated-duration line says only what the drawing gives it", () => {
  it("draws the duration the answer carries", async () => {
    const view = mount(settled({}), { durationCopy: "About 45s – 3.4 hr." });
    await rowsOf(view);
    expect(
      view.container.querySelector('[data-conformance-id="schedule-duration"]')?.textContent,
    ).toBe("About 45s – 3.4 hr.");
  });

  // SUPERSEDED BY THE SECOND GRADED ROUND (cinatra#3174 fix leg 3). This used
  // to pin the opposite reading — no line at all where there is no estimate —
  // on the ground that the drawing gives no wording for an empty one. The
  // second round then measured the line missing from all eight frames and
  // failed it against §VI, which draws "Estimated run duration" beneath the
  // rows in every one of its five pictures. The line therefore stands in every
  // reading, and the empty reading's word is kept in the shared leaf.
  it("draws the LINE even where there is no estimate — the drawing draws it in every picture", async () => {
    for (const [body, aside] of [
      [settled({}), {}],
      [FIRED_ONE_OFF, { firedOnce: true }],
    ] as Array<[TriggerScheduleProposalViewBody, Aside]>) {
      const view = mount(body, aside);
      await rowsOf(view);
      expect(view.container.textContent ?? "").toContain("Estimated run duration");
      expect(
        view.container.querySelector('[data-conformance-id="schedule-duration"]')?.textContent,
      ).toBe(DURATION_LINE_NO_ESTIMATE);
      cleanup();
    }
  });
});

describe("the configured reading's floor is Save changes, quiet until a row changes", () => {
  it("stands quiet on an armed recurring schedule until the reader changes a row", async () => {
    const view = mount(
      settled({ schedule: RECURRING, triggerType: "recurring", canSave: true }),
      { durationCopy: "About 45s – 3.4 hr." },
    );
    await rowsOf(view);
    expect(
      view.container
        .querySelector('[data-conformance-id="schedule-proposal-card"]')
        ?.getAttribute("data-schedule-reading"),
    ).toBe("configured");
    const save = view.container.querySelector('[data-action="save-schedule-changes"]');
    expect(save).not.toBeNull();
    expect(save?.textContent).toContain("Save changes");
    expect((save as HTMLButtonElement).disabled).toBe(true);

    const timezone = view.container.querySelector('[data-field="recurring-timezone"]');
    expect(timezone).not.toBeNull();
    fireEvent.change(timezone as HTMLInputElement, { target: { value: "Europe/Lisbon" } });
    await waitFor(() =>
      expect(
        (
          view.container.querySelector(
            '[data-action="save-schedule-changes"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
});
