// @vitest-environment jsdom
//
// A RECURRING MINUTE OUTSIDE THE FIVE-MINUTE GRID (cinatra#3278), on the
// schedule card's own rows.
//
// The ratified drawing, app-lifecycle-cards section VI: "There is no raw cron
// field: the schedule the reader stated is what the reader sees and confirms",
// and the Standard scheduling step draws the time as "an At hour:minute
// time-of-day". A schedule stored at 05:12 therefore has to READ as 05:12 on
// the rows the reader confirms — and it did not: the minute control offered
// the twelve multiples of five only, the stored 12 matched no option, and the
// minute segment drew blank while the hour beside it drew 05.
//
// The stored five-field cron stays the source and the parse is untouched (the
// issue's own decision): what changes here is the drawn control's option set,
// and nothing else. Its shape is the same Select the section draws — pinned
// below, so a later slice cannot answer the same defect with a typed field.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-minute-grid-3278.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";
import { buildCron } from "../trigger-recurrence";

// jsdom ships no ResizeObserver, no pointer capture and no scrollIntoView; the
// app's Select (Radix) calls all three to open its listbox. These are test-
// ENVIRONMENT shims, not relaxed assertions: every clause below is read off
// the options the real control rendered. The originals are put back in
// `afterEach` so the file leaves the environment as it found it.
const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ELEMENT_SHIMS = {
  hasPointerCapture: Element.prototype.hasPointerCapture,
  releasePointerCapture: Element.prototype.releasePointerCapture,
  scrollIntoView: Element.prototype.scrollIntoView,
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installSelectShims() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  Element.prototype.hasPointerCapture = ORIGINAL_ELEMENT_SHIMS.hasPointerCapture;
  Element.prototype.releasePointerCapture = ORIGINAL_ELEMENT_SHIMS.releasePointerCapture;
  Element.prototype.scrollIntoView = ORIGINAL_ELEMENT_SHIMS.scrollIntoView;
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "proposal-ref-3278",
};

/** THE STORED SCHEDULE THE ISSUE WAS MEASURED ON: daily, at 05:12. */
const DAILY_AT_0512: ProposedSchedule = {
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
    hour: 5,
    minute: 12,
  },
};

const PROPOSAL: TriggerScheduleProposalViewBody = {
  phase: "proposal",
  version: 1,
  agentName: "Weekly cohort sweep",
  schedule: DAILY_AT_0512,
  durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true,
  restrictedReason: null,
};

/** The same stored schedule, on the reading whose rows go read-only. */
const STOPPED: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-3278",
  schedule: DAILY_AT_0512,
  triggerType: "recurring",
  scheduleCopy: "Every day at 05:12",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: true,
  arming: false,
  canSave: false,
  canCancel: false,
  stopped: true,
};

function mockTransport(state: LifecycleCardState, body: TriggerScheduleProposalViewBody) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    return new Response(
      JSON.stringify(
        isDecision
          ? { outcome: { kind: "confirmed", runId: "run-3278", alreadyConfirmed: false } }
          : { kind: "trigger_schedule_proposal", state, body },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderCard() {
  installSelectShims();
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** The minute control's own options, read off the opened listbox. */
async function openMinuteOptions(container: HTMLElement): Promise<string[]> {
  const trigger = container.querySelector('[data-field="recurring-minute"]');
  expect(trigger).not.toBeNull();
  fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false, pointerType: "mouse" });
  await waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
  );
  return Array.from(document.querySelectorAll('[role="option"]')).map(
    (option) => option.textContent ?? "",
  );
}

async function rows(container: HTMLElement): Promise<void> {
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull(),
  );
}

describe("the recurring-minute control on the schedule card", () => {
  // "The recurring-minute controls in both `ScheduleProposalCard` and
  //  `TriggerScreenClient` can display and select every minute from `00`
  //  through `59`."
  it("offers every minute from 00 through 59", async () => {
    mockTransport({ state: "pending", canDecide: true, canComment: false }, PROPOSAL);
    const { container } = renderCard();
    await rows(container);

    expect(await openMinuteOptions(container)).toEqual(
      Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0")),
    );
  });

  // The drawn shape is unchanged — section VI's "At hour:minute" is still two
  // pickers and still has no raw cron field anywhere on the card.
  it("keeps the drawn control: the same picker, and no raw field", async () => {
    mockTransport({ state: "pending", canDecide: true, canComment: false }, PROPOSAL);
    const { container } = renderCard();
    await rows(container);

    const trigger = container.querySelector('[data-field="recurring-minute"]');
    expect(trigger?.getAttribute("data-slot")).toBe("select-trigger");
    expect(trigger?.getAttribute("aria-label")).toBe("Minute");
    expect(container.querySelector('input[data-field="recurring-minute"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/cron/i);
  });

  // "Editable and read-only renderings show the same hour and minute for the
  //  same stored schedule."
  it("reads the stored 05:12 as 05:12 on the editable rows and on the read-only rows", async () => {
    mockTransport({ state: "pending", canDecide: true, canComment: false }, PROPOSAL);
    const editable = renderCard();
    await rows(editable.container);
    expect(
      editable.container.querySelector('[data-field="recurring-hour"]')?.textContent,
    ).toBe("05");
    expect(
      editable.container.querySelector('[data-field="recurring-minute"]')?.textContent,
    ).toBe("12");

    cleanup();

    mockTransport({ state: "settled" } as LifecycleCardState, STOPPED);
    const readOnly = renderCard();
    await rows(readOnly.container);
    // The pickers are gone on this reading; the value is drawn as text, and it
    // is the same hour and the same minute.
    expect(readOnly.container.querySelector('[data-field="recurring-minute"]')).toBeNull();
    expect(readOnly.container.textContent).toContain("05:12");
  });

  // "Component tests render a stored daily schedule at `05:12`, assert that
  //  both surfaces visibly show `12`, change it to another non-five-minute
  //  value, and assert the resulting cron."
  it("changes the stored 05:12 to 05:47 and carries the selection whose cron is 47 5 * * *", async () => {
    const fetchMock = mockTransport(
      { state: "pending", canDecide: true, canComment: false },
      PROPOSAL,
    );
    const { container } = renderCard();
    await rows(container);
    await openMinuteOptions(container);

    const fortySeven = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent === "47",
    );
    expect(fortySeven).toBeDefined();
    fireEvent.click(fortySeven!);

    await waitFor(() =>
      expect(container.querySelector('[data-field="recurring-minute"]')?.textContent).toBe("47"),
    );

    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

    const sent = await waitFor(() => {
      const decisions = fetchMock.mock.calls
        .map(([, init]) => (init as RequestInit | undefined)?.body)
        .filter((body): body is string => typeof body === "string" && body.includes('"op"'))
        .map((body) => JSON.parse(body) as { schedule?: ProposedSchedule });
      expect(decisions.length).toBeGreaterThan(0);
      return decisions[decisions.length - 1];
    });

    expect(sent.schedule?.kind).toBe("recurring");
    const selection = (sent.schedule as Extract<ProposedSchedule, { kind: "recurring" }>).selection;
    expect(selection.minute).toBe(47);
    expect(selection.hour).toBe(5);
    // The selections travel and the cron is derived from them — the stored
    // five-field cron this schedule becomes.
    expect(buildCron(selection)).toBe("47 5 * * *");
  });
});
