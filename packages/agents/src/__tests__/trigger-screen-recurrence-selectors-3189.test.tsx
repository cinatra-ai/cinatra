// @vitest-environment jsdom
//
// THE SCHEDULING STEP'S FREQUENCY SELECTORS, NOW THE SHARED ONES (cinatra#3189).
//
// The step's quarter anchor, month, Day/Weekday mode, day of month, week of
// month and weekday moved into the component the schedule card draws as well.
// The step's own reading and its stored cron have to be what they were: these
// drive the form the person sees, by each control's name, and read the cron
// the form submits. One clause is new — a stated day of month past 28 is drawn,
// never blanked, the rule cinatra#3278 set for the minute.
//
// THE DAY OF MONTH AN ASSISTANT FILL MAY SET (cinatra#4377). A fill sets only a
// day the select offers as a new choice, 1-28; 0, 32, NaN, a fraction, a string
// and a day 29-31 leave the select and the cron as they were, and none of them
// becomes an option. A saved day 29-31 (the stated schedule) is still drawn.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-recurrence-selectors-3189.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  ProposedSchedule,
  RecurringSelection,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

const routerState = vi.hoisted(() => ({ push: vi.fn() as ReturnType<typeof vi.fn> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push, refresh: vi.fn() }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import { setRunTrigger } from "../run-actions";
import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";
import { dayOfMonthOptions } from "../schedule-proposal-card";

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

// jsdom ships no ResizeObserver, no pointer capture and no scrollIntoView; the
// app's Select (Radix) calls all three to open its listbox. Test-environment
// shims only, restored in `afterEach`.
function installSelectShims() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

const BASE: RecurringSelection = {
  frequency: "monthly",
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

const stated = (over: Partial<RecurringSelection>): ProposedSchedule => ({
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: { ...BASE, ...over },
});

function renderForm(statedSchedule: ProposedSchedule) {
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
    statedSchedule,
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

function storedCron(container: HTMLElement): string {
  const field = container.querySelector('input[name="cronExpression"]');
  return (field as HTMLInputElement | null)?.value ?? "";
}

const byLabel = (container: HTMLElement, label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;

const buttonNamed = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === name) ?? null;

/** Which of the frequency-dependent controls the form draws. */
function drawn(container: HTMLElement): string[] {
  const out: string[] = [];
  if (buttonNamed(container, "Start") && buttonNamed(container, "End")) out.push("quarter-anchor");
  if (byLabel(container, "Month")) out.push("month");
  if (buttonNamed(container, "Day") && buttonNamed(container, "Weekday")) out.push("mode");
  if (byLabel(container, "Day of month")) out.push("day-of-month");
  if (byLabel(container, "Week of month")) out.push("week-of-month");
  if (byLabel(container, "Weekday")) out.push("weekday");
  return out;
}

async function pick(trigger: HTMLElement, text: string) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  await waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
  );
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (o) => o.textContent === text,
  );
  expect(option).toBeDefined();
  fireEvent.click(option!);
}

describe("the scheduling step's frequency selectors (cinatra#3189)", () => {
  const MATRIX: Record<RecurringSelection["frequency"], string[]> = {
    daily: [],
    weekly: [],
    monthly: ["mode", "day-of-month"],
    quarterly: ["quarter-anchor", "mode", "day-of-month"],
    yearly: ["month", "mode", "day-of-month"],
  };

  for (const frequency of Object.keys(MATRIX) as RecurringSelection["frequency"][]) {
    it(`draws exactly the controls a ${frequency} schedule carries`, async () => {
      const { container } = renderForm(stated({ frequency }));
      await waitFor(() => expect(screen.getByText("At")).not.toBeNull());
      expect(drawn(container)).toEqual(MATRIX[frequency]);
    });
  }

  it("draws the week of month and the weekday in Weekday mode, and stores their cron", async () => {
    const { container } = renderForm(
      stated({ frequency: "monthly", monthlyMode: "weekday", nthWeek: 3, monthlyWeekday: 4 }),
    );
    await waitFor(() => expect(byLabel(container, "Week of month")).not.toBeNull());
    expect(drawn(container)).toEqual(["mode", "week-of-month", "weekday"]);
    expect(byLabel(container, "Week of month")!.textContent).toBe("3rd");
    expect(byLabel(container, "Weekday")!.textContent).toBe("Thu");
    expect(storedCron(container)).toBe("0 9 15-21 * 4");
  });

  it("a changed day of month is the stored cron", async () => {
    const { container } = renderForm(stated({ frequency: "monthly", dayOfMonth: 1 }));
    await waitFor(() => expect(byLabel(container, "Day of month")).not.toBeNull());
    expect(storedCron(container)).toBe("0 9 1 * *");
    await pick(byLabel(container, "Day of month")!, "15");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 15 * *"));
    expect(byLabel(container, "Day of month")!.textContent).toBe("15");
  });

  it("Continue submits the changed day of month in the cron it arms", async () => {
    vi.mocked(setRunTrigger).mockResolvedValueOnce({ ok: true, runId: "run-abc", jobSchedulerId: null });
    const { container } = renderForm(stated({ frequency: "monthly", dayOfMonth: 1 }));
    await waitFor(() => expect(byLabel(container, "Day of month")).not.toBeNull());
    await pick(byLabel(container, "Day of month")!, "15");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 15 * *"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(vi.mocked(setRunTrigger)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setRunTrigger).mock.calls[0][0]).toMatchObject({
      runId: "run-abc",
      triggerType: "recurring",
      cronExpression: "0 9 15 * *",
    });
  });

  it("pressing End moves a quarterly schedule to the quarter's last months", async () => {
    const { container } = renderForm(stated({ frequency: "quarterly", dayOfMonth: 10 }));
    await waitFor(() => expect(buttonNamed(container, "End")).not.toBeNull());
    expect(storedCron(container)).toBe("0 9 10 1,4,7,10 *");
    fireEvent.click(buttonNamed(container, "End")!);
    await waitFor(() => expect(storedCron(container)).toBe("0 9 10 3,6,9,12 *"));
  });

  it("a changed month is the stored cron of a yearly schedule", async () => {
    const { container } = renderForm(stated({ frequency: "yearly", yearlyMonth: 1, dayOfMonth: 5 }));
    await waitFor(() => expect(byLabel(container, "Month")).not.toBeNull());
    expect(byLabel(container, "Month")!.textContent).toBe("Jan");
    await pick(byLabel(container, "Month")!, "Jul");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 5 7 *"));
  });

  it("pressing Weekday switches the stored cron to the nth-weekday form", async () => {
    const { container } = renderForm(stated({ frequency: "monthly", nthWeek: 2, monthlyWeekday: 1 }));
    await waitFor(() => expect(buttonNamed(container, "Weekday")).not.toBeNull());
    fireEvent.click(buttonNamed(container, "Weekday")!);
    await waitFor(() => expect(storedCron(container)).toBe("0 9 8-14 * 1"));
  });

  it("draws a stated day of month past 28 — 31 is drawn, never blanked", async () => {
    const { container } = renderForm(stated({ frequency: "monthly", dayOfMonth: 31 }));
    await waitFor(() => expect(byLabel(container, "Day of month")).not.toBeNull());
    expect(byLabel(container, "Day of month")!.textContent).toBe("31");
    expect(storedCron(container)).toBe("0 9 31 * *");
  });
});

const DAYS_1_TO_28 = Array.from({ length: 28 }, (_, i) => String(i + 1));

function propsFor(statedSchedule: ProposedSchedule): TriggerScreenClientProps {
  return {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    statedSchedule,
    embeddedAsRenderer: true,
  };
}

/** The step as the HITL renderer mounts it, on a stated day; then one assistant fill. */
async function renderThenFill(day: number, fill: Record<string, unknown>) {
  installSelectShims();
  const props = propsFor(stated({ frequency: "monthly", dayOfMonth: day }));
  const view = render(<TriggerScreenClient {...props} />);
  await waitFor(() => expect(byLabel(view.container, "Day of month")).not.toBeNull());
  expect(storedCron(view.container)).toBe(`0 9 ${day} * *`);
  view.rerender(<TriggerScreenClient {...props} aiSuggestions={fill} />);
  return view.container;
}

/** The texts of the options the open Day of month select draws. */
async function dayOptions(container: HTMLElement): Promise<string[]> {
  fireEvent.pointerDown(byLabel(container, "Day of month")!, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  await waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
  );
  return Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");
}

describe("the day of month an assistant fill may set (cinatra#4377)", () => {
  for (const [name, value] of [
    ["0", 0],
    ["32", 32],
    ["NaN", Number.NaN],
    ["the fraction 1.5", 1.5],
  ] as const) {
    it(`a filled day of ${name} keeps the select and the cron, and is never an option`, async () => {
      const container = await renderThenFill(10, { dayOfMonth: value });
      expect(byLabel(container, "Day of month")!.textContent).toBe("10");
      expect(storedCron(container)).toBe("0 9 10 * *");
      expect(await dayOptions(container)).toEqual(DAYS_1_TO_28);
    });
  }

  it("a filled day of 31 is not a new choice: the select and the cron keep their day", async () => {
    const container = await renderThenFill(10, { dayOfMonth: 31 });
    expect(byLabel(container, "Day of month")!.textContent).toBe("10");
    expect(storedCron(container)).toBe("0 9 10 * *");
    expect(await dayOptions(container)).toEqual(DAYS_1_TO_28);
  });

  it("a filled day given as the string \"15\" is not a day: the select and the cron keep theirs", async () => {
    const container = await renderThenFill(10, { dayOfMonth: "15" });
    expect(byLabel(container, "Day of month")!.textContent).toBe("10");
    expect(storedCron(container)).toBe("0 9 10 * *");
  });

  it("a filled day of 15 moves the select and the cron (the fill road itself)", async () => {
    const container = await renderThenFill(10, { dayOfMonth: 15 });
    await waitFor(() => expect(storedCron(container)).toBe("0 9 15 * *"));
    expect(byLabel(container, "Day of month")!.textContent).toBe("15");
  });

  it("a saved day of 31 stays drawn and stored when a fill names day 0", async () => {
    const container = await renderThenFill(31, { dayOfMonth: 0 });
    expect(byLabel(container, "Day of month")!.textContent).toBe("31");
    expect(storedCron(container)).toBe("0 9 31 * *");
    expect(await dayOptions(container)).toEqual([...DAYS_1_TO_28, "31"]);
  });

  it("a refused day leaves the fill's other rows applied", async () => {
    const container = await renderThenFill(10, { dayOfMonth: 32, hour: 14 });
    await waitFor(() => expect(storedCron(container)).toBe("0 14 10 * *"));
    expect(byLabel(container, "Day of month")!.textContent).toBe("10");
  });
});

describe("dayOfMonthOptions adds a saved day 29-31 and nothing else (cinatra#4377)", () => {
  const plain = Array.from({ length: 28 }, (_, i) => i + 1);

  for (const value of [0, 32, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    it(`${value} is not added: the options stay 1-28`, () => {
      expect(dayOfMonthOptions(value)).toEqual(plain);
    });
  }

  for (const value of [29, 30, 31]) {
    it(`a saved day of ${value} is added after 28`, () => {
      expect(dayOfMonthOptions(value)).toEqual([...plain, value]);
    });
  }

  it("a day in 1-28 adds nothing", () => {
    expect(dayOfMonthOptions(15)).toEqual(plain);
  });
});
