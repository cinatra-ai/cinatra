// @vitest-environment jsdom
//
// A FILLED CRON'S DAY FIELD, ELEMENT BY ELEMENT (cinatra#4407).
//
// The scheduling step applies a filled cron only when `parseCronToRecurring`
// reads it back (and the day it names is one the select offers as a new
// choice, 1-28). The reader now checks every day that a list, a range or a
// step in the day field names, and the day it reads, so these crons are
// refused and neither the select nor the stored cron moves:
//
//   0 9 0,15 * *    0 9 0-5 * *    0 9 1,32 * *    0 9 -5 * *
//
// A day range on the quarter months with a day-of-week of `*` names no weekday;
// its range is checked the same way, so these are refused too:
//
//   0 9 32-40 1,4,7,10 *    0 9 0-5 1,4,7,10 *    0 9 1-40 3,6,9,12 *
//
// A cron that has a day-of-week field (a weekday number in the fifth field) is
// not a date cron; its day field is not checked, and the fill applies it as
// given. That present reading is pinned:
//
//   0 9 32 * 1   0 9 31 * 1   0 9 32-40 * 1   0 9 32 1 1   0 9 32-40 1,4,7,10 1
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-day-field-fill-4407.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type {
  ProposedSchedule,
  RecurringSelection,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import { TriggerScreenClient, type TriggerScreenClientProps } from "../trigger-screen-client";

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

const BASE: RecurringSelection = {
  frequency: "monthly",
  interval: 1,
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 10,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 1,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 9,
  minute: 0,
};

const STATED: ProposedSchedule = { kind: "recurring", timezone: "Europe/Berlin", selection: BASE };

function propsFor(): TriggerScreenClientProps {
  return {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    statedSchedule: STATED,
    embeddedAsRenderer: true,
  };
}

const storedCron = (container: HTMLElement) =>
  (container.querySelector('input[name="cronExpression"]') as HTMLInputElement | null)?.value ?? "";
const byLabel = (container: HTMLElement, label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const frequencyText = (container: HTMLElement) =>
  container.querySelector('[aria-label="Repeat unit"]')?.textContent ?? null;

/** The step as the HITL renderer mounts it on day 10; then one assistant fill of a cron. */
async function renderThenFillCron(cronExpression: string) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  const props = propsFor();
  const view = render(<TriggerScreenClient {...props} />);
  await waitFor(() => expect(byLabel(view.container, "Day of month")).not.toBeNull());
  expect(storedCron(view.container)).toBe("0 9 10 * *");
  view.rerender(
    <TriggerScreenClient {...props} aiSuggestions={{ triggerType: "recurring", cronExpression }} />,
  );
  return view.container;
}

beforeEach(() => {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  Element.prototype.hasPointerCapture = ORIGINAL_ELEMENT_SHIMS.hasPointerCapture;
  Element.prototype.releasePointerCapture = ORIGINAL_ELEMENT_SHIMS.releasePointerCapture;
  Element.prototype.scrollIntoView = ORIGINAL_ELEMENT_SHIMS.scrollIntoView;
});

describe("a filled date cron with a day outside 1-31 in a list or range is refused (cinatra#4407)", () => {
  for (const cron of [
    "0 9 0,15 * *",
    "0 9 0-5 * *",
    "0 9 1,32 * *",
    // a field that starts with a minus
    "0 9 -5 * *",
    // a day range on the quarter months with a day-of-week of `*`
    "0 9 32-40 1,4,7,10 *",
    "0 9 0-5 1,4,7,10 *",
    "0 9 1-40 3,6,9,12 *",
  ]) {
    it(`"${cron}" moves neither the select nor the stored cron`, async () => {
      const container = await renderThenFillCron(cron);
      expect(byLabel(container, "Day of month")!.textContent).toBe("10");
      expect(storedCron(container)).toBe("0 9 10 * *");
      expect(frequencyText(container)).toBe("month(s)");
    });
  }
});

// The day field of a cron that has a day-of-week field is not checked. The fill
// applies the expression as given, and the rows draw what the reader reads from
// it. Pinned, so the behaviour is stated and cannot change by accident.
describe("a filled cron with a day-of-week field is applied as given, its day field unchecked (cinatra#4407)", () => {
  it("0 9 32 * 1 is stored with the 32 and draws a weekly schedule", async () => {
    const container = await renderThenFillCron("0 9 32 * 1");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 32 * 1"));
    expect(frequencyText(container)).toBe("week(s)");
    expect(byLabel(container, "Day of month")).toBeNull();
  });

  it("0 9 31 * 1 is stored and draws a weekly schedule", async () => {
    const container = await renderThenFillCron("0 9 31 * 1");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 31 * 1"));
    expect(frequencyText(container)).toBe("week(s)");
  });

  it("0 9 32-40 * 1 is stored and draws the 4th Monday of every month", async () => {
    const container = await renderThenFillCron("0 9 32-40 * 1");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 32-40 * 1"));
    expect(frequencyText(container)).toBe("month(s)");
    expect(byLabel(container, "Week of month")!.textContent).toBe("4th");
    expect(byLabel(container, "Weekday")!.textContent).toBe("Mon");
  });

  it("0 9 32 1 1 is stored and draws a daily schedule", async () => {
    const container = await renderThenFillCron("0 9 32 1 1");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 32 1 1"));
    expect(frequencyText(container)).toBe("day(s)");
  });

  it("0 9 32-40 1,4,7,10 1 is stored and draws the 4th Monday of the quarter start", async () => {
    const container = await renderThenFillCron("0 9 32-40 1,4,7,10 1");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 32-40 1,4,7,10 1"));
    expect(frequencyText(container)).toBe("quarter");
    expect(byLabel(container, "Week of month")!.textContent).toBe("4th");
    expect(byLabel(container, "Weekday")!.textContent).toBe("Mon");
  });
});

// A legal day range on the quarter months with a day-of-week of `*` is applied
// as before: the check refuses only a range with an end outside 1-31.
describe("a filled quarter-month day range with a day-of-week of `*` whose ends are days is applied (cinatra#4407)", () => {
  it("0 9 1-7 1,4,7,10 * is stored and draws the 1st Sunday of the quarter start", async () => {
    const container = await renderThenFillCron("0 9 1-7 1,4,7,10 *");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 1-7 1,4,7,10 *"));
    expect(frequencyText(container)).toBe("quarter");
    expect(byLabel(container, "Week of month")!.textContent).toBe("1st");
    expect(byLabel(container, "Weekday")!.textContent).toBe("Sun");
  });
});
