// @vitest-environment jsdom
//
// THE EMBEDDED RENDERER'S SUBMISSION AFTER A SHARED SELECTOR IS CHANGED
// (cinatra#4407).
//
// Mounted as a HITL field renderer (`embeddedAsRenderer` with `onSubmit`), the
// scheduling step hands its validated values to the parent instead of arming
// the schedule itself: `setRunTrigger` is never called and the page does not
// move. The values must carry the cron the shared selectors (the quarter anchor,
// the month, Day / Weekday, the day of month, the week of month and the weekday)
// built, so what the parent persists is what the person can read.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-embedded-submit-4407.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  ProposedSchedule,
  RecurringSelection,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

const routerState = vi.hoisted(() => ({
  push: vi.fn() as ReturnType<typeof vi.fn>,
  refresh: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push, refresh: routerState.refresh }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import { setRunTrigger } from "../run-actions";
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

type Submitted = { triggerType: string; cronExpression?: string; timezone?: string };

function renderEmbedded(
  statedSchedule: ProposedSchedule,
  onSubmit: (values: Submitted) => void | Promise<void>,
) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
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
    embeddedAsRenderer: true,
    onSubmit: onSubmit as TriggerScreenClientProps["onSubmit"],
  };
  return render(<TriggerScreenClient {...props} />);
}

beforeEach(() => {
  routerState.push.mockReset();
  routerState.refresh.mockReset();
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

const storedCron = (container: HTMLElement) =>
  (container.querySelector('input[name="cronExpression"]') as HTMLInputElement | null)?.value ?? "";
const byLabel = (container: HTMLElement, label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const buttonNamed = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === name) ?? null;

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

describe("the embedded renderer submits the cron the shared selectors built (cinatra#4407)", () => {
  it("a changed day of month is the cron handed to the parent, and nothing is armed or redirected", async () => {
    const onSubmit = vi.fn();
    const { container } = renderEmbedded(stated({ frequency: "monthly", dayOfMonth: 1 }), onSubmit);
    await waitFor(() => expect(byLabel(container, "Day of month")).not.toBeNull());
    await pick(byLabel(container, "Day of month")!, "15");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 15 * *"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      triggerType: "recurring",
      timezone: "Europe/Berlin",
      cronExpression: "0 9 15 * *",
    });
    expect(vi.mocked(setRunTrigger)).not.toHaveBeenCalled();
    expect(routerState.push).not.toHaveBeenCalled();
    expect(routerState.refresh).not.toHaveBeenCalled();
  });

  it("a pressed End and a changed day are the quarterly cron handed to the parent", async () => {
    const onSubmit = vi.fn();
    const { container } = renderEmbedded(stated({ frequency: "quarterly", dayOfMonth: 10 }), onSubmit);
    await waitFor(() => expect(buttonNamed(container, "End")).not.toBeNull());
    fireEvent.click(buttonNamed(container, "End")!);
    await waitFor(() => expect(storedCron(container)).toBe("0 9 10 3,6,9,12 *"));
    await pick(byLabel(container, "Day of month")!, "20");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 20 3,6,9,12 *"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ cronExpression: "0 9 20 3,6,9,12 *" });
    expect(vi.mocked(setRunTrigger)).not.toHaveBeenCalled();
  });

  it("a pressed Weekday and a changed week and weekday are the nth-weekday cron handed to the parent", async () => {
    const onSubmit = vi.fn();
    const { container } = renderEmbedded(stated({ frequency: "monthly", nthWeek: 1, monthlyWeekday: 1 }), onSubmit);
    await waitFor(() => expect(buttonNamed(container, "Weekday")).not.toBeNull());
    fireEvent.click(buttonNamed(container, "Weekday")!);
    await waitFor(() => expect(byLabel(container, "Week of month")).not.toBeNull());
    await pick(byLabel(container, "Week of month")!, "3rd");
    await pick(byLabel(container, "Weekday")!, "Fri");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 15-21 * 5"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ cronExpression: "0 9 15-21 * 5" });
  });

  it("a changed month of a yearly schedule is the cron handed to the parent", async () => {
    const onSubmit = vi.fn();
    const { container } = renderEmbedded(stated({ frequency: "yearly", yearlyMonth: 1, dayOfMonth: 5 }), onSubmit);
    await waitFor(() => expect(byLabel(container, "Month")).not.toBeNull());
    await pick(byLabel(container, "Month")!, "Jul");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 5 7 *"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ cronExpression: "0 9 5 7 *" });
  });

  it("a parent's rejected submit shows its message and still arms nothing here", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("The parent refused the schedule."));
    const { container } = renderEmbedded(stated({ frequency: "monthly", dayOfMonth: 1 }), onSubmit);
    await waitFor(() => expect(byLabel(container, "Day of month")).not.toBeNull());
    await pick(byLabel(container, "Day of month")!, "9");
    await waitFor(() => expect(storedCron(container)).toBe("0 9 9 * *"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(container.textContent).toContain("The parent refused the schedule."));
    expect(vi.mocked(setRunTrigger)).not.toHaveBeenCalled();
    expect(routerState.push).not.toHaveBeenCalled();
  });
});
