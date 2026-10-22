// @vitest-environment jsdom
//
// THE SCHEDULE CARD'S FREQUENCY SELECTORS (cinatra#3189).
//
// Components, the standard scheduling step: the recurring row carries "a day-of-month or nth-weekday choice for monthly,
// quarterly and yearly; a quarter anchor; a month". The conversational card
// drew weekday toggles only,
// so a monthly, quarterly or yearly proposal could be neither read nor
// corrected on the card. These read the card the person sees.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-proposal-card-3189.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  RecurringSelection,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

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
  ref: "proposal-ref-3189",
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

const recurringSchedule = (over: Partial<RecurringSelection> = {}): ProposedSchedule => ({
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: { ...BASE_SELECTION, ...over },
});

const SCHEDULED: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2099-07-14T09:00",
  timezone: "Europe/Berlin",
};

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: false };

function proposal(schedule: ProposedSchedule): TriggerScheduleProposalViewBody {
  return {
    phase: "proposal",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule,
    durationCopy: "About 45s – 3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
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
    runId: "run-3189",
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

function mockTransport(state: LifecycleCardState, body: TriggerScheduleProposalViewBody) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    return new Response(
      JSON.stringify(
        isDecision
          ? { outcome: { kind: "confirmed", runId: "run-3189", alreadyConfirmed: false } }
          : { kind: "trigger_schedule_proposal", state, body },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderCard(state: LifecycleCardState, body: TriggerScheduleProposalViewBody) {
  const fetchMock = mockTransport(state, body);
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

/** Every decision body the card posted, in order. */
function decisions(fetchMock: ReturnType<typeof vi.fn>): { op?: string; schedule?: ProposedSchedule }[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter((body): body is string => typeof body === "string" && body.includes('"op"'))
    .map((body) => JSON.parse(body));
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

// ---------------------------------------------------------------------------
// P6 — the frequency-dependent selectors
// ---------------------------------------------------------------------------

describe("the card draws the recurring row's frequency selectors (cinatra#3189 P6)", () => {
  const MATRIX: Record<RecurringSelection["frequency"], string[]> = {
    daily: [],
    weekly: [],
    monthly: ["recurring-monthly-mode", "recurring-day-of-month"],
    quarterly: ["recurring-quarter-anchor", "recurring-monthly-mode", "recurring-day-of-month"],
    yearly: ["recurring-yearly-month", "recurring-monthly-mode", "recurring-day-of-month"],
  };

  for (const frequency of Object.keys(MATRIX) as RecurringSelection["frequency"][]) {
    it(`draws exactly the shared controls a ${frequency} schedule carries`, async () => {
      const { rows } = await renderCard(PENDING, proposal(recurringSchedule({ frequency })));
      expect(sharedFieldsDrawn(rows)).toEqual(MATRIX[frequency]);
    });
  }

  it("draws the week of month and the weekday, and no day of month, in Weekday mode", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "monthly", monthlyMode: "weekday", nthWeek: 3, monthlyWeekday: 4 })),
    );
    expect(sharedFieldsDrawn(rows)).toEqual([
      "recurring-monthly-mode",
      "recurring-nth-week",
      "recurring-monthly-weekday",
    ]);
    expect(rows.querySelector('[data-field="recurring-nth-week"]')?.textContent).toBe("3rd");
    expect(rows.querySelector('[data-field="recurring-monthly-weekday"]')?.textContent).toBe("Thu");
    expect(
      rows.querySelector('[data-field="recurring-monthly-mode"][data-mode="weekday"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      rows.querySelector('[data-field="recurring-monthly-mode"][data-mode="date"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  for (const anchor of ["start", "end"] as const) {
    it(`marks the stated quarter anchor (${anchor})`, async () => {
      const { rows } = await renderCard(
        PENDING,
        proposal(recurringSchedule({ frequency: "quarterly", quarterAnchor: anchor })),
      );
      const other = anchor === "start" ? "end" : "start";
      expect(
        rows.querySelector(`[data-field="recurring-quarter-anchor"][data-anchor="${anchor}"]`)?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        rows.querySelector(`[data-field="recurring-quarter-anchor"][data-anchor="${other}"]`)?.getAttribute("aria-pressed"),
      ).toBe("false");
    });
  }

  it("draws the stated month of a yearly schedule", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "yearly", yearlyMonth: 7 })),
    );
    expect(rows.querySelector('[data-field="recurring-yearly-month"]')?.textContent).toBe("Jul");
  });

  it("draws a stated day of month past 28 — 31 is drawn, never blanked", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "monthly", dayOfMonth: 31 })),
    );
    expect(rows.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("31");
  });

  it("a schedule that is over draws the selections as text, with no control", async () => {
    const { rows } = await renderCard(
      { state: "settled" } as LifecycleCardState,
      settled(recurringSchedule({ frequency: "quarterly", quarterAnchor: "end", dayOfMonth: 15 }), {
        canSave: false,
        canCancel: false,
        stopped: true,
      }),
    );
    expect(sharedFieldsDrawn(rows)).toEqual([]);
    expect(rows.querySelector('[data-readonly-field="recurring-quarter-anchor"]')?.textContent).toContain("End");
    expect(rows.querySelector('[data-readonly-field="recurring-monthly-mode"]')?.textContent).toContain("Day");
    expect(rows.querySelector('[data-readonly-field="recurring-day-of-month"]')?.textContent).toContain("15");
  });

  it("a reader who may not act sees every shared control drawn and refusing", async () => {
    for (const over of [
      { frequency: "quarterly" as const },
      { frequency: "yearly" as const, monthlyMode: "weekday" as const },
    ]) {
      const { rows, unmount } = await renderCard(
        { state: "settled" } as LifecycleCardState,
        settled(recurringSchedule(over), { canSave: false }),
      );
      const drawn = Array.from(
        rows.querySelectorAll(SHARED_FIELDS.map((f) => `[data-field="${f}"]`).join(",")),
      );
      expect(drawn.length).toBeGreaterThan(2);
      for (const control of drawn) {
        expect((control as HTMLButtonElement).disabled, control.getAttribute("data-field") ?? "").toBe(true);
      }
      unmount();
      cleanup();
    }
  });

  it("pressing End moves the quarter anchor", async () => {
    const { rows } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "quarterly", quarterAnchor: "start" })),
    );
    fireEvent.click(rows.querySelector('[data-field="recurring-quarter-anchor"][data-anchor="end"]')!);
    await waitFor(() =>
      expect(
        rows.querySelector('[data-field="recurring-quarter-anchor"][data-anchor="end"]')?.getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("a changed day of month is in the body Save changes posts", async () => {
    const { rows, fetchMock, container } = await renderCard(
      { state: "settled" } as LifecycleCardState,
      settled(recurringSchedule({ frequency: "monthly", dayOfMonth: 1 })),
    );
    fireEvent.pointerDown(rows.querySelector('[data-field="recurring-day-of-month"]')!, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    await waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
    );
    fireEvent.click(
      Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent === "20")!,
    );
    await waitFor(() =>
      expect(rows.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("20"),
    );
    const save = container.querySelector('[data-action="save-schedule-changes"]') as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
    const posted = decisions(fetchMock)[0];
    expect(posted.op).toBe("save");
    expect(
      (posted.schedule as Extract<ProposedSchedule, { kind: "recurring" }>).selection.dayOfMonth,
    ).toBe(20);
  });

  it("a changed day of month is in the body Confirm posts", async () => {
    const { rows, fetchMock, container } = await renderCard(
      PENDING,
      proposal(recurringSchedule({ frequency: "monthly", dayOfMonth: 1 })),
    );
    fireEvent.pointerDown(rows.querySelector('[data-field="recurring-day-of-month"]')!, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    await waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
    );
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((o) => o.textContent)).toEqual(
      Array.from({ length: 28 }, (_, i) => String(i + 1)),
    );
    fireEvent.click(options.find((o) => o.textContent === "15")!);
    await waitFor(() =>
      expect(rows.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("15"),
    );
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() => expect(decisions(fetchMock).length).toBeGreaterThan(0));
    const sent = decisions(fetchMock).map(
      (d) => (d.schedule as Extract<ProposedSchedule, { kind: "recurring" }> | undefined)?.selection,
    );
    expect(sent.some((s) => s?.dayOfMonth === 15 && s.frequency === "monthly")).toBe(true);
  });
});
