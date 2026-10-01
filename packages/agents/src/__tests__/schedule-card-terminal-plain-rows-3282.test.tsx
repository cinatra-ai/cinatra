// @vitest-environment jsdom
//
// THE TERMINAL READINGS ARE PLAIN VALUE ROWS IN THE DRAWING'S OWN FORMAT
// (cinatra#3282, epic #3248).
//
// §VI, on the reading a spent one-off settles into: "Once it has fired, the
// card is a reading. A one-off that has fired cannot be changed, so the rows go
// read-only — the values still legible, the pickers gone — and the card carries
// no floor at all: no hairline, no button, nothing to press." Its own fired
// example draws that moment as "14.07.2026, 09:00" beside "Europe/Berlin", and
// no picture in the section draws a 12-hour clock anywhere.
//
// §VI, on the recurring schedule once it has been stopped: "Pressing it stops
// the recurring schedule, and the rows are not editable after that."
//
// TWO CLOCKS IN ONE CARD is what this file closes. The recurring reading has
// always read its time as a 24-hour HH:mm; the one-off's moment was handed to
// `toLocaleString`, so the same card family read "Jul 14, 2026, 9:00 AM" beside
// "Every day at 17:30" and the format the reader saw depended on the user agent
// and the locale rather than on the drawing.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-card-terminal-plain-rows-3282.test.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

// THE FILE PUTS BACK WHAT IT TOOK. `fetch` is a global the card reads through,
// so the original is captured before the first mount and restored after every
// test — a package run with this file present must leave every other file's
// fetch exactly as it found it.
const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = REAL_FETCH;
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "ref-3282",
};

/** The drawing's own spent example: "Run at 14.07.2026, 09:00 · Timezone
 *  Europe/Berlin", carried on the wire as the timezone-naive wall clock the
 *  form emits. */
const ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2026-07-14T09:00",
  timezone: "Europe/Berlin",
};

/** A recurring selection whose time is one a 12-hour clock would rewrite:
 *  17:30 reads "5:30 PM" the moment a locale formatter touches it. */
const RECURRING: ProposedSchedule = {
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: {
    frequency: "daily",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 1,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 17,
    minute: 30,
  },
};

function settled(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>>,
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Q3 cohort sweep",
    runId: "run-3282",
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

function mount(body: TriggerScheduleProposalViewBody, aside: { firedOnce?: boolean } = {}) {
  const state: LifecycleCardState = { state: "settled" };
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state,
          body,
          ...(aside.firedOnce ? { firedOnce: true } : {}),
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

/** Every widget a reader could put a cursor in, counted over the rows the
 *  reading is drawn from. */
function controlsIn(rows: Element): number {
  return (
    rows.querySelectorAll("input").length +
    rows.querySelectorAll("select").length +
    rows.querySelectorAll("textarea").length +
    rows.querySelectorAll("button").length +
    rows.querySelectorAll('[role="combobox"]').length +
    rows.querySelectorAll("[data-field]").length
  );
}

/** THE SPENT ONE-OFF: the gate opened AND the run ran, so the resolver carries
 *  the fired reading beside the body and the card freezes on it. */
const SPENT_ONE_OFF = settled({ released: true, canSave: false });

/** THE STOPPED RECURRING: Cancel schedule was pressed, so the server offers
 *  neither a save nor a cancel and the body says the schedule is stopped. */
const STOPPED_RECURRING = settled({
  schedule: RECURRING,
  triggerType: "recurring",
  scheduleCopy: "Every day at 17:30",
  canSave: false,
  canCancel: false,
  stopped: true,
});

describe("the spent one-off is a plain value row in the drawing's fixed format", () => {
  it("draws the moment as DD.MM.YYYY, HH:mm — the drawing's own 14.07.2026, 09:00", async () => {
    const rows = await rowsOf(mount(SPENT_ONE_OFF, { firedOnce: true }));
    const text = rows.textContent ?? "";
    expect(text).toContain("14.07.2026, 09:00");
    // AND NOT THE USER AGENT'S OWN CLOCK. A locale formatter reaches the same
    // wall clock as "Jul 14, 2026, 9:00 AM" or "14/07/2026, 09:00" depending on
    // the reader's browser; the drawing fixes one reading for every reader.
    expect(text).not.toContain("AM");
    expect(text).not.toContain("PM");
    expect(text).not.toContain("Jul");
    // The wire's own string is not the reading either.
    expect(text).not.toContain("2026-07-14T09:00");
  });

  it("names the zone the moment is stated in, as its own plain row", async () => {
    const rows = await rowsOf(mount(SPENT_ONE_OFF, { firedOnce: true }));
    const text = rows.textContent ?? "";
    expect(text).toContain("Run at");
    expect(text).toContain("Timezone");
    expect(text).toContain("Europe/Berlin");
  });

  it("leaves no form control in the terminal value rows", async () => {
    const rows = await rowsOf(mount(SPENT_ONE_OFF, { firedOnce: true }));
    expect(controlsIn(rows)).toBe(0);
  });
});

describe("the stopped recurring schedule is a plain value row too", () => {
  it("keeps its 24-hour time — the same clock the one-off now reads", async () => {
    const rows = await rowsOf(mount(STOPPED_RECURRING));
    const text = rows.textContent ?? "";
    expect(text).toContain("Every day at 17:30");
    expect(text).not.toContain("5:30");
    expect(text).not.toContain("PM");
  });

  it("names the zone beside it, as its own plain row", async () => {
    const rows = await rowsOf(mount(STOPPED_RECURRING));
    const text = rows.textContent ?? "";
    expect(text).toContain("Repeats");
    expect(text).toContain("Timezone");
    expect(text).toContain("Europe/Berlin");
  });

  it("leaves no form control in the terminal value rows", async () => {
    const rows = await rowsOf(mount(STOPPED_RECURRING));
    expect(controlsIn(rows)).toBe(0);
  });

  it("still marks the recurring row as the one the schedule stands on", async () => {
    const rows = await rowsOf(mount(STOPPED_RECURRING));
    expect(
      rows.querySelector('[data-schedule-option="recurring"]')?.getAttribute("data-chosen"),
    ).toBe("true");
    expect(
      rows.querySelector('[data-schedule-option="scheduled"]')?.getAttribute("data-chosen"),
    ).toBe("false");
  });
});

/** The two value nodes a terminal reading draws — the pair §VI draws under
 *  "Run at" and "Timezone" on its spent example, and the pair the stopped
 *  recurring reading draws under "Repeats" and "Timezone". */
function valueNodes(rows: Element): HTMLElement[] {
  return Array.from(rows.querySelectorAll<HTMLElement>("[data-schedule-value]"));
}

describe("the terminal value is a reading, not a control that has been switched off", () => {
  // §VI: "A one-off that has fired cannot be changed, so the rows go read-only
  // — the values still legible, the pickers gone". The drawing's own spent
  // example draws each value as a recessed reading — the soft hairline
  // (var(--line)) over the paper fill (var(--paper)) — and NOT as the editable
  // field beside it, which carries the control's own border (var(--line-strong))
  // over the raised surface (var(--surface-strong)).
  //
  // THE INK IS THE DRAWING'S (cinatra#3282, fix leg 2). §VI's spent example
  // draws the VALUE inside that hairline box in the muted ink —
  // color:var(--muted) on "14.07.2026, 09:00" and on "Europe/Berlin" — and
  // the LABEL above it in the ink colour, color:var(--ink) on "Run at" and
  // "Timezone". The app's tokens map --muted-foreground to var(--muted) and
  // --border to var(--line) (packages/design/src/tokens.css), so the drawn
  // value ink is `text-muted-foreground` and the drawn box border is
  // `border-border`.
  //
  // The reading used to carry `border-input` — the control's border, token for
  // token the one the live Input draws — so a spent reading was a field with
  // its control taken out rather than a value where a field stood. That border
  // is the one thing the reading trades away; the fill, the measure and the
  // drawn inks stay.
  for (const [name, body, aside] of [
    ["the spent one-off", SPENT_ONE_OFF, { firedOnce: true }],
    ["the stopped recurring schedule", STOPPED_RECURRING, {}],
  ] as const) {
    it(`${name} draws its values in the drawing's muted ink, never the label ink`, async () => {
      const nodes = valueNodes(await rowsOf(mount(body, aside)));
      expect(nodes).toHaveLength(2);
      for (const node of nodes) {
        expect(node.classList.contains("text-muted-foreground"), node.textContent ?? "").toBe(
          true,
        );
        expect(node.classList.contains("text-foreground"), node.textContent ?? "").toBe(false);
      }
    });

    it(`${name} draws its values with the reading's hairline, never the control's border`, async () => {
      const nodes = valueNodes(await rowsOf(mount(body, aside)));
      expect(nodes).toHaveLength(2);
      for (const node of nodes) {
        expect(node.classList.contains("border-border"), node.textContent ?? "").toBe(true);
        expect(node.classList.contains("border-input"), node.textContent ?? "").toBe(false);
      }
    });
  }
});
