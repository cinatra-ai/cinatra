// @vitest-environment jsdom
//
// A RECURRING MINUTE OUTSIDE THE FIVE-MINUTE GRID (cinatra#3278), on the
// scheduling step's own form.
//
// The same defect the schedule card carried, in the second place that builds
// the minute options: a schedule stated at 05:12 drew 05 beside a blank
// minute, because 12 matched none of the twelve multiples of five the control
// offered. The drawing (app-lifecycle-cards section VI) admits no raw cron
// field — "the schedule the reader stated is what the reader sees and
// confirms" — so the minute the form holds has to be one the control can draw.
//
// The parse is untouched: the form's stored five-field cron already carried
// 12, and it is asserted here beside the reading.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-minute-grid-3278.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

// The screen navigates on a successful arm and calls the trigger server
// action; neither is exercised here, and both are the same two seams the
// existing form suite mocks.
const routerState = vi.hoisted(() => ({ push: vi.fn() as ReturnType<typeof vi.fn> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import { setRunTrigger } from "../run-actions";
import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";

// jsdom ships no ResizeObserver, no pointer capture and no scrollIntoView; the
// app's Select (Radix) calls all three to open its listbox. Test-ENVIRONMENT
// shims only — every clause is read off what the real control rendered — and
// the originals are restored in `afterEach`.
const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
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

/** THE STATED SCHEDULE THE ISSUE WAS MEASURED ON: daily, at 05:12. */
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

function renderForm(overrides: Partial<TriggerScreenClientProps> = {}) {
  installSelectShims();
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    statedSchedule: DAILY_AT_0512,
    ...overrides,
  };
  return render(<TriggerScreenClient {...props} />);
}

beforeEach(() => {
  routerState.push.mockReset();
  vi.mocked(setRunTrigger).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  Element.prototype.hasPointerCapture = ORIGINAL_ELEMENT_SHIMS.hasPointerCapture;
  Element.prototype.releasePointerCapture = ORIGINAL_ELEMENT_SHIMS.releasePointerCapture;
  Element.prototype.scrollIntoView = ORIGINAL_ELEMENT_SHIMS.scrollIntoView;
});

/** The step's "At hour:minute" row — the hour picker, then the minute picker. */
async function timeOfDayPickers(): Promise<{ hour: HTMLElement; minute: HTMLElement }> {
  const row = await waitFor(() => {
    const at = screen.getByText("At").parentElement;
    expect(at).not.toBeNull();
    return at as HTMLElement;
  });
  const pickers = Array.from(row.querySelectorAll('[data-slot="select-trigger"]'));
  expect(pickers).toHaveLength(2);
  return { hour: pickers[0] as HTMLElement, minute: pickers[1] as HTMLElement };
}

function storedCron(container: HTMLElement): string {
  const field = container.querySelector('input[name="cronExpression"]');
  return (field as HTMLInputElement | null)?.value ?? "";
}

describe("the recurring-minute control on the scheduling step", () => {
  // "The recurring-minute controls in both `ScheduleProposalCard` and
  //  `TriggerScreenClient` can display and select every minute from `00`
  //  through `59`."
  it("offers every minute from 00 through 59", async () => {
    renderForm();
    const { minute } = await timeOfDayPickers();

    fireEvent.pointerDown(minute, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
    );

    expect(
      Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent),
    ).toEqual(Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0")));
  });

  // "Editable and read-only renderings show the same hour and minute for the
  //  same stored schedule."
  it("reads the stated 05:12 as 05:12 on the editable form and on the read-only reading", async () => {
    const editable = renderForm();
    const live = await timeOfDayPickers();
    expect(live.hour.textContent).toBe("05");
    expect(live.minute.textContent).toBe("12");
    // The stored five-field cron held 12 all along — the parse was never the
    // defect, and this pins that it still is not.
    expect(storedCron(editable.container)).toBe("12 5 * * *");

    cleanup();

    renderForm({ readOnly: true });
    const reading = await timeOfDayPickers();
    expect(reading.hour.textContent).toBe("05");
    expect(reading.minute.textContent).toBe("12");
  });

  // "Component tests render a stored daily schedule at `05:12`, assert that
  //  both surfaces visibly show `12`, change it to another non-five-minute
  //  value, and assert the resulting cron."
  it("changes the stated 05:12 to 05:47 and stores the cron 47 5 * * *", async () => {
    const { container } = renderForm();
    const { minute } = await timeOfDayPickers();

    fireEvent.pointerDown(minute, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
    );
    const fortySeven = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent === "47",
    );
    expect(fortySeven).toBeDefined();
    fireEvent.click(fortySeven!);

    await waitFor(() => expect(storedCron(container)).toBe("47 5 * * *"));
    const changed = await timeOfDayPickers();
    expect(changed.minute.textContent).toBe("47");
  });
});
