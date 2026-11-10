// @vitest-environment jsdom
//
// THE BRANCHES OF THE CARD'S FREQUENCY SELECTORS THAT NO TEST COVERED
// (cinatra#4407, the follow-up of cinatra#4280 and #4377).
//
//   1. a stopped yearly schedule in Weekday mode, read-only
//   2. the week of month and the weekday, changed through their handlers
//   3. the Day / Weekday segment, pressed
//   4. the pressed segment's styling while the controls are disabled
//   5. a live change of frequency (monthly every 12 to quarterly and yearly)
//   6. a missing or unknown frequency at runtime
//   7. the waiting run's direct Confirm, after a shared selector changed
//   8. the expired card's repropose, after a shared selector changed
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-proposal-card-4407.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  RecurringSelection,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  RecurrenceFrequencySelectors,
  ScheduleProposalCard,
  ScheduleProposalCardBody,
} from "../schedule-proposal-card";
import { normalizeRecurringConfig } from "../trigger-recurrence";

// jsdom shims — the app's Select (Radix) calls layout APIs jsdom omits. Test-environment only.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  }
}
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "proposal-ref-4407",
};

const BASE_SELECTION: RecurringSelection = {
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
};

type Recurring = Extract<ProposedSchedule, { kind: "recurring" }>;

const recurringSchedule = (over: Partial<RecurringSelection> = {}): Recurring => ({
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: { ...BASE_SELECTION, ...over },
});

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: false };
const SETTLED: LifecycleCardState = { state: "settled" };

function proposal(
  schedule: ProposedSchedule,
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "proposal" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "proposal",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule,
    durationCopy: "About 45s – 3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
    ...over,
  };
}

function settled(
  schedule: ProposedSchedule,
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Weekly cohort sweep",
    runId: "run-4407",
    schedule,
    triggerType: "recurring",
    scheduleCopy: "Every month",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    canCancel: true,
    ...over,
  };
}

function expired(schedule: ProposedSchedule): TriggerScheduleProposalViewBody {
  return {
    phase: "expired",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule,
    scheduleCopy: "Every month",
  };
}

type Outcome = unknown;

/** A transport that answers the resolve with `body` and each decision with the next of `outcomes`. */
function mockTransport(
  state: LifecycleCardState,
  body: TriggerScheduleProposalViewBody,
  outcomes: Outcome[] = [{ kind: "confirmed", runId: "run-4407", alreadyConfirmed: false }],
) {
  let decision = 0;
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    const outcome = outcomes[Math.min(decision, outcomes.length - 1)];
    if (isDecision) decision += 1;
    return new Response(
      JSON.stringify(
        isDecision ? { outcome } : { kind: "trigger_schedule_proposal", state, body },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderCard(
  state: LifecycleCardState,
  body: TriggerScheduleProposalViewBody,
  outcomes?: Outcome[],
) {
  const fetchMock = mockTransport(state, body, outcomes);
  const view = render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
    ).not.toBeNull(),
  );
  const rows = view.container.querySelector(
    '[data-conformance-id="schedule-option-rows"]',
  ) as HTMLElement;
  return { ...view, rows, fetchMock };
}

type Decision = { op?: string; ref?: string; schedule?: ProposedSchedule };

/** Every decision body the card posted, in order. */
function decisions(fetchMock: ReturnType<typeof vi.fn>): Decision[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter((body): body is string => typeof body === "string" && body.includes('"op"'))
    .map((body) => JSON.parse(body));
}

const selectionOf = (d: Decision | undefined) => (d?.schedule as Recurring | undefined)?.selection;

/** Open the Select that carries `field` and choose the option with `text`. */
async function pick(rows: HTMLElement, field: string, text: string) {
  const trigger = rows.querySelector(`[data-field="${field}"]`);
  expect(trigger, `no ${field}`).not.toBeNull();
  fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false, pointerType: "mouse" });
  await waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
  );
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (o) => o.textContent === text,
  );
  expect(option, `no option ${text}`).toBeDefined();
  fireEvent.click(option!);
}

const SHARED_FIELDS = [
  "recurring-quarter-anchor",
  "recurring-yearly-month",
  "recurring-monthly-mode",
  "recurring-day-of-month",
  "recurring-nth-week",
  "recurring-monthly-weekday",
] as const;

function sharedFieldsDrawn(rows: HTMLElement): string[] {
  return SHARED_FIELDS.filter((f) => rows.querySelector(`[data-field="${f}"]`) !== null);
}

const readOnlyText = (rows: HTMLElement, field: string) =>
  rows.querySelector(`[data-readonly-field="${field}"]`)?.textContent ?? null;

// ---------------------------------------------------------------------------
// 1. A stopped yearly schedule in Weekday mode
// ---------------------------------------------------------------------------

describe("a stopped yearly schedule in Weekday mode draws as text (cinatra#4407)", () => {
  it("month 7 on the fourth Saturday: every selection is text and nothing is pressable", async () => {
    const { rows } = await renderCard(
      SETTLED,
      settled(
        recurringSchedule({
          frequency: "yearly",
          monthlyMode: "weekday",
          yearlyMonth: 7,
          nthWeek: 4,
          monthlyWeekday: 6,
        }),
        { canSave: false, canCancel: false, stopped: true },
      ),
    );
    expect(sharedFieldsDrawn(rows)).toEqual([]);
    expect(readOnlyText(rows, "recurring-yearly-month")).toContain("Jul");
    expect(readOnlyText(rows, "recurring-monthly-mode")).toContain("Weekday");
    expect(readOnlyText(rows, "recurring-nth-week")).toContain("4th");
    expect(readOnlyText(rows, "recurring-monthly-weekday")).toContain("Sat");
    // Weekday mode names no day of month.
    expect(rows.querySelector('[data-readonly-field="recurring-day-of-month"]')).toBeNull();
    expect(readOnlyText(rows, "recurring-interval")).toBeNull();
    expect(readOnlyText(rows, "recurring-frequency")).toContain("year");
  });
});

// ---------------------------------------------------------------------------
// 2. The week of month and the weekday, through their handlers
// ---------------------------------------------------------------------------

describe("the week of month and the weekday are changed through their handlers (cinatra#4407)", () => {
  it("a changed week of month and weekday are in the body Save changes posts", async () => {
    const { rows, container, fetchMock } = await renderCard(
      SETTLED,
      settled(recurringSchedule({ frequency: "monthly", monthlyMode: "weekday", nthWeek: 1, monthlyWeekday: 1 })),
    );
    await pick(rows, "recurring-nth-week", "3rd");
    await waitFor(() =>
      expect(rows.querySelector('[data-field="recurring-nth-week"]')?.textContent).toBe("3rd"),
    );
    await pick(rows, "recurring-monthly-weekday", "Fri");
    await waitFor(() =>
      expect(rows.querySelector('[data-field="recurring-monthly-weekday"]')?.textContent).toBe("Fri"),
    );
    const save = container.querySelector('[data-action="save-schedule-changes"]') as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
    const posted = decisions(fetchMock)[0];
    expect(posted.op).toBe("save");
    expect(selectionOf(posted)).toMatchObject({
      frequency: "monthly",
      monthlyMode: "weekday",
      nthWeek: 3,
      monthlyWeekday: 5,
    });
  });

  it("the week of month offers 1st to 4th and the weekday offers Sun to Sat", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "monthly", monthlyMode: "weekday" })),
    );
    fireEvent.pointerDown(rows.querySelector('[data-field="recurring-nth-week"]')!, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    await waitFor(() => expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
    expect(Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The Day / Weekday segment, pressed
// ---------------------------------------------------------------------------

describe("pressing the Day / Weekday segment moves the mode (cinatra#4407)", () => {
  const modeButton = (rows: HTMLElement, mode: "date" | "weekday") =>
    rows.querySelector(`[data-field="recurring-monthly-mode"][data-mode="${mode}"]`) as HTMLElement;

  it("pressing Weekday swaps the day of month for the week of month and the weekday", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "monthly", monthlyMode: "date", dayOfMonth: 12 })),
    );
    expect(modeButton(rows, "date").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(modeButton(rows, "weekday"));
    await waitFor(() => expect(modeButton(rows, "weekday").getAttribute("aria-pressed")).toBe("true"));
    expect(modeButton(rows, "date").getAttribute("aria-pressed")).toBe("false");
    expect(sharedFieldsDrawn(rows)).toEqual([
      "recurring-monthly-mode",
      "recurring-nth-week",
      "recurring-monthly-weekday",
    ]);
  });

  it("pressing Day brings the day of month back, on the day the schedule held", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "quarterly", monthlyMode: "weekday", dayOfMonth: 12 })),
    );
    fireEvent.click(modeButton(rows, "date"));
    await waitFor(() => expect(modeButton(rows, "date").getAttribute("aria-pressed")).toBe("true"));
    expect(modeButton(rows, "weekday").getAttribute("aria-pressed")).toBe("false");
    expect(rows.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("12");
    expect(rows.querySelector('[data-field="recurring-nth-week"]')).toBeNull();
  });

  it("the pressed mode is in the body Save changes posts", async () => {
    const { rows, container, fetchMock } = await renderCard(
      SETTLED,
      settled(recurringSchedule({ frequency: "yearly", monthlyMode: "date", yearlyMonth: 3 })),
    );
    fireEvent.click(modeButton(rows, "weekday"));
    const save = container.querySelector('[data-action="save-schedule-changes"]') as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
    expect(selectionOf(decisions(fetchMock)[0])).toMatchObject({
      frequency: "yearly",
      monthlyMode: "weekday",
      yearlyMonth: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The pressed segment's styling while the controls are disabled
// ---------------------------------------------------------------------------

/** The background classes of an element, modifiers included (`bg-clip-*` is not a fill). */
function fills(el: Element): string[] {
  return (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((c) => /^([a-z-]+:)*bg-/.test(c) && !/(^|:)bg-clip-/.test(c));
}

/** The themed or hover ink classes of an element (`dark:text-*`, `hover:text-*`). */
function modifiedInks(el: Element): string[] {
  return (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((c) => /^([a-z-]+:)+text-/.test(c));
}

describe("the pressed half of a segmented pair keeps its drawing while the controls are disabled (cinatra#4407)", () => {
  const PAIRS = [
    {
      name: "the quarter anchor",
      schedule: recurringSchedule({ frequency: "quarterly", quarterAnchor: "end" }),
      field: "recurring-quarter-anchor",
    },
    {
      name: "Day / Weekday",
      schedule: recurringSchedule({ frequency: "monthly", monthlyMode: "weekday" }),
      field: "recurring-monthly-mode",
    },
  ] as const;

  for (const pair of PAIRS) {
    it(`${pair.name}: both halves are disabled and the pressed one is indigo with white ink`, async () => {
      const { rows } = await renderCard(SETTLED, settled(pair.schedule, { canSave: false }));
      const halves = Array.from(rows.querySelectorAll(`[data-field="${pair.field}"]`)) as HTMLButtonElement[];
      expect(halves).toHaveLength(2);
      for (const half of halves) expect(half.disabled).toBe(true);
      const pressed = rows.querySelector(`[data-field="${pair.field}"][aria-pressed="true"]`);
      expect(pressed, "no pressed half").not.toBeNull();
      expect(fills(pressed!)).toEqual(["bg-indigo-ink"]);
      expect(pressed!.getAttribute("class")).toMatch(/(^|\s)text-white(\s|$)/);
      expect(modifiedInks(pressed!)).toEqual([]);
    });

    it(`${pair.name}: the other half stands on the reserved surface while disabled`, async () => {
      const { rows } = await renderCard(SETTLED, settled(pair.schedule, { canSave: false }));
      const other = rows.querySelector(`[data-field="${pair.field}"][aria-pressed="false"]`);
      expect(other, "no unpressed half").not.toBeNull();
      expect((other as HTMLButtonElement).disabled).toBe(true);
      const f = fills(other!);
      expect(f).toContain("bg-surface-strong");
      expect(f).toContain("dark:bg-surface-strong");
    });

    it(`${pair.name}: pressing a disabled half moves nothing`, async () => {
      const { rows, fetchMock } = await renderCard(SETTLED, settled(pair.schedule, { canSave: false }));
      const before = Array.from(rows.querySelectorAll(`[data-field="${pair.field}"]`)).map((h) =>
        h.getAttribute("aria-pressed"),
      );
      const other = rows.querySelector(`[data-field="${pair.field}"][aria-pressed="false"]`)!;
      fireEvent.click(other);
      expect(
        Array.from(rows.querySelectorAll(`[data-field="${pair.field}"]`)).map((h) => h.getAttribute("aria-pressed")),
      ).toEqual(before);
      expect(decisions(fetchMock)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. A live change of frequency
// ---------------------------------------------------------------------------

describe("a live change of frequency from a monthly schedule every 12 months (cinatra#4407)", () => {
  for (const [label, frequency, drawn] of [
    ["quarter", "quarterly", ["recurring-quarter-anchor", "recurring-monthly-mode", "recurring-day-of-month"]],
    ["year", "yearly", ["recurring-yearly-month", "recurring-monthly-mode", "recurring-day-of-month"]],
  ] as const) {
    it(`changing to ${label} draws the ${frequency} controls and no interval number`, async () => {
      const { rows } = await renderCard(
        PENDING,
        proposal(recurringSchedule({ frequency: "monthly", interval: 12, dayOfMonth: 10 })),
      );
      expect(rows.querySelector('[data-field="recurring-interval"]')?.textContent).toBe("12");
      await pick(rows, "recurring-frequency", label);
      await waitFor(() => expect(rows.querySelector('[data-field="recurring-frequency"]')?.textContent).toBe(label));
      expect(rows.querySelector('[data-field="recurring-interval"]')).toBeNull();
      expect(sharedFieldsDrawn(rows)).toEqual(drawn);
    });

    it(`changing to ${label} and pressing Confirm submits ${frequency}; the server's normalization makes the interval 1`, async () => {
      const { rows, container, fetchMock } = await renderCard(
        PENDING,
        proposal(recurringSchedule({ frequency: "monthly", interval: 12, dayOfMonth: 10 })),
      );
      await pick(rows, "recurring-frequency", label);
      await waitFor(() => expect(rows.querySelector('[data-field="recurring-frequency"]')?.textContent).toBe(label));
      fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
      await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
      const sent = selectionOf(decisions(fetchMock)[0]);
      expect(sent).toMatchObject({ frequency, dayOfMonth: 10 });
      // The card sends the rows it holds. The producer's boundary then pins a
      // quarter and a year to every 1 (the form hides the number), whatever the
      // interval the monthly row carried.
      expect(normalizeRecurringConfig(sent)).toMatchObject({ frequency, interval: 1, dayOfMonth: 10 });
    });
  }

  it("changing a quarterly schedule back to month(s) draws the interval number again", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "quarterly", interval: 1 })),
    );
    expect(rows.querySelector('[data-field="recurring-interval"]')).toBeNull();
    await pick(rows, "recurring-frequency", "month(s)");
    await waitFor(() => expect(rows.querySelector('[data-field="recurring-interval"]')).not.toBeNull());
    expect(sharedFieldsDrawn(rows)).toEqual(["recurring-monthly-mode", "recurring-day-of-month"]);
  });

  it("a missing frequency is refused by the producer's boundary", () => {
    const { frequency: _omitted, ...withoutFrequency } = BASE_SELECTION;
    void _omitted;
    expect(normalizeRecurringConfig(withoutFrequency)).toBeNull();
    expect(normalizeRecurringConfig({ ...BASE_SELECTION, frequency: undefined })).toBeNull();
    expect(normalizeRecurringConfig({ ...BASE_SELECTION, frequency: null })).toBeNull();
    expect(normalizeRecurringConfig({ ...BASE_SELECTION, frequency: "hourly" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. A missing or unknown frequency at runtime
// ---------------------------------------------------------------------------

/** The drawn card over a body the wire schema would have refused (no server behind it). */
function drawBody(state: LifecycleCardState, body: TriggerScheduleProposalViewBody) {
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ScheduleProposalCardBody
        state={state}
        body={body}
        firedOnce={false}
        durationCopy={null}
        onDecide={async () => ({ kind: "error", message: "unused" })}
        onAdjustAndConfirm={async () => ({ kind: "error", message: "unused" })}
        onRepropose={async () => ({ kind: "error", message: "unused" })}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("a missing or unknown frequency at runtime draws no selector and does not throw (cinatra#4407)", () => {
  for (const [name, frequency] of [
    ["an unknown word", "hourly"],
    ["undefined", undefined],
    ["null", null],
  ] as const) {
    const unknownFrequency = () =>
      recurringSchedule({ frequency: frequency as unknown as RecurringSelection["frequency"] });

    it(`the resolved card with ${name} is drawn as nothing: the wire schema refuses the body`, async () => {
      const fetchMock = mockTransport(PENDING, proposal(unknownFrequency()));
      const again = render(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <ScheduleProposalCard view={VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(again.container.querySelector('[data-conformance-id="schedule-option-rows"]')).toBeNull();
      expect(again.container.querySelector('[data-action="confirm-schedule-proposal"]')).toBeNull();
    });

    it(`the editable card body with ${name} draws no shared control and no interval number`, () => {
      const { container } = drawBody(PENDING, proposal(unknownFrequency()));
      const rows = container.querySelector('[data-conformance-id="schedule-option-rows"]') as HTMLElement;
      expect(rows).not.toBeNull();
      expect(sharedFieldsDrawn(rows)).toEqual([]);
      expect(rows.querySelector('[data-field="recurring-interval"]')).toBeNull();
    });

    it(`the read-only card body with ${name} draws no shared value and no interval number`, () => {
      const { container } = drawBody(
        SETTLED,
        settled(unknownFrequency(), { canSave: false, canCancel: false, stopped: true }),
      );
      const rows = container.querySelector('[data-conformance-id="schedule-option-rows"]') as HTMLElement;
      expect(rows).not.toBeNull();
      for (const field of [
        "recurring-quarter-anchor",
        "recurring-yearly-month",
        "recurring-monthly-mode",
        "recurring-day-of-month",
        "recurring-nth-week",
        "recurring-monthly-weekday",
        "recurring-interval",
      ]) {
        expect(rows.querySelector(`[data-readonly-field="${field}"]`), field).toBeNull();
      }
    });
  }

  it("the shared selectors draw nothing for a frequency they do not carry", () => {
    for (const frequency of [undefined, null, "hourly", "daily", "weekly"]) {
      const { container, unmount } = render(
        <RecurrenceFrequencySelectors
          selection={{
            frequency: frequency as unknown as RecurringSelection["frequency"],
            monthlyMode: "date",
            dayOfMonth: 1,
            nthWeek: 1,
            monthlyWeekday: 1,
            quarterAnchor: "start",
            yearlyMonth: 1,
          }}
          onChange={() => {}}
          disabled={false}
          readOnly={false}
        />,
      );
      expect(container.innerHTML, String(frequency)).toBe("");
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The waiting run's direct Confirm
// ---------------------------------------------------------------------------

describe("the waiting run's direct Confirm carries a shared selector that was changed (cinatra#4407)", () => {
  it("sends ONE confirm whose rows hold the picked frequency and day of month", async () => {
    const { rows, container, fetchMock } = await renderCard(
      PENDING,
      proposal({ kind: "immediate" }, { runPending: true, durationCopy: null }),
    );
    // Choose the recurring row, then change the rows the shared selectors own.
    fireEvent.click(container.querySelector('[data-schedule-option="recurring"] button')!);
    await waitFor(() => expect(rows.querySelector('[data-field="recurring-frequency"]')).not.toBeNull());
    await pick(rows, "recurring-frequency", "month(s)");
    await waitFor(() => expect(rows.querySelector('[data-field="recurring-day-of-month"]')).not.toBeNull());
    await pick(rows, "recurring-day-of-month", "15");
    await waitFor(() =>
      expect(rows.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("15"),
    );
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
    const bodies = decisions(fetchMock);
    // One request, straight to confirm: never the proposal's re-propose composite.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].op).toBe("confirm");
    expect(bodies[0].ref).toBe(VIEW.ref);
    expect(selectionOf(bodies[0])).toMatchObject({
      frequency: "monthly",
      monthlyMode: "date",
      dayOfMonth: 15,
    });
  });

  it("sends ONE confirm whose rows hold a pressed Weekday mode and the picked week", async () => {
    const { rows, container, fetchMock } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "monthly" }), { runPending: true, durationCopy: null }),
    );
    fireEvent.click(rows.querySelector('[data-field="recurring-monthly-mode"][data-mode="weekday"]')!);
    await waitFor(() => expect(rows.querySelector('[data-field="recurring-nth-week"]')).not.toBeNull());
    await pick(rows, "recurring-nth-week", "2nd");
    await waitFor(() => expect(rows.querySelector('[data-field="recurring-nth-week"]')?.textContent).toBe("2nd"));
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
    expect(decisions(fetchMock)).toHaveLength(1);
    expect(decisions(fetchMock)[0].op).toBe("confirm");
    expect(selectionOf(decisions(fetchMock)[0])).toMatchObject({ monthlyMode: "weekday", nthWeek: 2 });
  });
});

// ---------------------------------------------------------------------------
// 8. The expired card's repropose
// ---------------------------------------------------------------------------

describe("the expired card's repropose carries a shared selector that was changed (cinatra#4407)", () => {
  it("Confirm re-proposes the picked rows on the expired ref, then confirms the replacement", async () => {
    const { rows, container, fetchMock } = await renderCard(
      PENDING,
      expired(recurringSchedule({ frequency: "quarterly", quarterAnchor: "start", dayOfMonth: 5 })),
      [
        { kind: "reproposed", ref: "proposal-ref-4407-new", expiresAt: 4_102_444_800_000 },
        { kind: "confirmed", runId: "run-4407", alreadyConfirmed: false },
      ],
    );
    expect(container.querySelector('[data-conformance-id="schedule-proposal-expired"]')).not.toBeNull();
    fireEvent.click(rows.querySelector('[data-field="recurring-quarter-anchor"][data-anchor="end"]')!);
    await waitFor(() =>
      expect(
        rows.querySelector('[data-field="recurring-quarter-anchor"][data-anchor="end"]')?.getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    await pick(rows, "recurring-day-of-month", "20");
    await waitFor(() =>
      expect(rows.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("20"),
    );
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() => expect(decisions(fetchMock).length).toBe(2));
    const [adjust, confirm] = decisions(fetchMock);
    expect(adjust.op).toBe("adjust");
    expect(adjust.ref).toBe(VIEW.ref);
    expect(selectionOf(adjust)).toMatchObject({
      frequency: "quarterly",
      quarterAnchor: "end",
      dayOfMonth: 20,
    });
    // The replacement, not the expired token, is what is confirmed.
    expect(confirm.op).toBe("confirm");
    expect(confirm.ref).toBe("proposal-ref-4407-new");
  });

  it("a refused repropose shows the refusal and the picked rows stay", async () => {
    const { rows, container, fetchMock } = await renderCard(
      PENDING,
      expired(recurringSchedule({ frequency: "yearly", yearlyMonth: 2 })),
      [{ kind: "not-permitted", message: "You may not confirm this schedule." }],
    );
    await pick(rows, "recurring-yearly-month", "Sep");
    await waitFor(() => expect(rows.querySelector('[data-field="recurring-yearly-month"]')?.textContent).toBe("Sep"));
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-proposal-refusal"]')?.textContent).toContain(
        "You may not confirm this schedule.",
      ),
    );
    expect(decisions(fetchMock)).toHaveLength(1);
    expect(rows.querySelector('[data-field="recurring-yearly-month"]')?.textContent).toBe("Sep");
  });
});
