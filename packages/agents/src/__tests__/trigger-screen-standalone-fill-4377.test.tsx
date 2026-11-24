// @vitest-environment jsdom
//
// THE STANDALONE FILL ROAD OF THE SCHEDULING STEP (cinatra#4377).
//
// The step applies an assistant fill from two callers: the HITL parent's
// `aiSuggestions` prop (read in trigger-screen-recurrence-selectors-3189) and,
// standalone, this screen's own window: `runWindow.send()` answers a turn, and
// its `fill.values` go through the same `applyScheduleValues`. These drive that
// second caller: the window's conversation hook is a stand-in, so a turn's fill
// is exactly the values named here.
//
// THE PAGE OWNS THE WINDOW (cinatra#3487): the screen mounts no panel of its
// own; it registers with `useRunWindowScreen`, and the page chrome calls the
// registered `onSubmit` with what the person typed. So a turn here is that call,
// read from the registration store the screen publishes into.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-standalone-fill-4377.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type {
  ProposedSchedule,
  RecurringSelection,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

const windowState = vi.hoisted(() => ({ send: vi.fn() as ReturnType<typeof vi.fn> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

vi.mock("../use-run-window-conversation", () => ({
  useRunWindowConversation: () => ({ entries: [], pending: false, send: windowState.send }),
}));

import {
  createRunWindowScreenStore,
  RunWindowScreenProvider,
  type RunWindowScreenStore,
} from "../run-window-screen-context";
import { TriggerScreenClient, type TriggerScreenClientProps } from "../trigger-screen-client";

const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

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

/** The store the screen registers its window with, as the page chrome holds it. */
let windowStore: RunWindowScreenStore;

function renderStandalone() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    statedSchedule: STATED,
  };
  windowStore = createRunWindowScreenStore();
  return render(
    <RunWindowScreenProvider store={windowStore}>
      <TriggerScreenClient {...props} />
    </RunWindowScreenProvider>,
  );
}

const storedCron = (container: HTMLElement) =>
  (container.querySelector('input[name="cronExpression"]') as HTMLInputElement | null)?.value ?? "";
const dayOfMonth = (container: HTMLElement) =>
  (container.querySelector('[aria-label="Day of month"]') as HTMLElement | null)?.textContent ?? null;

/**
 * One window turn whose effect is `effect`: the page chrome's call of the
 * screen's registered `onSubmit` with what the person typed. It resolves only
 * after the turn's answer was awaited and its fill (if any) applied, so a
 * refusal is read after the fill had its chance to land, never before.
 */
async function turn(effect: { fill: { values: Record<string, unknown> } | null; acted: boolean }) {
  windowState.send.mockResolvedValueOnce(effect);
  const registration = windowStore.read();
  // The screen lends the page a window it may type in: the schedule's own.
  expect(registration).not.toBeNull();
  expect(registration!.surface).toBe("schedule");
  expect(registration!.canManipulate).toBe(true);
  await act(async () => {
    await registration!.onSubmit("change the day");
  });
  expect(windowState.send).toHaveBeenCalledTimes(1);
  expect(windowState.send).toHaveBeenCalledWith("change the day");
}

beforeEach(() => {
  windowState.send.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
});

describe("the standalone window's fill of the day of month (cinatra#4377)", () => {
  it("a window fill of day 15 moves the select and the stored cron", async () => {
    const { container } = renderStandalone();
    await waitFor(() => expect(storedCron(container)).toBe("0 9 10 * *"));
    await turn({ fill: { values: { dayOfMonth: 15 } }, acted: false });
    await waitFor(() => expect(storedCron(container)).toBe("0 9 15 * *"));
    expect(dayOfMonth(container)).toBe("15");
  });

  it("a window fill of day 32 moves neither the select nor the stored cron", async () => {
    const { container } = renderStandalone();
    await waitFor(() => expect(storedCron(container)).toBe("0 9 10 * *"));
    await turn({ fill: { values: { dayOfMonth: 32 } }, acted: false });
    expect(dayOfMonth(container)).toBe("10");
    expect(storedCron(container)).toBe("0 9 10 * *");
  });

  it("a window fill of the cron 0 9 32 * * moves neither the select nor the stored cron", async () => {
    const { container } = renderStandalone();
    await waitFor(() => expect(storedCron(container)).toBe("0 9 10 * *"));
    await turn({ fill: { values: { triggerType: "recurring", cronExpression: "0 9 32 * *" } }, acted: false });
    expect(dayOfMonth(container)).toBe("10");
    expect(storedCron(container)).toBe("0 9 10 * *");
  });

  it("a turn that pressed a control writes no field, even a valid day", async () => {
    const { container } = renderStandalone();
    await waitFor(() => expect(storedCron(container)).toBe("0 9 10 * *"));
    await turn({ fill: { values: { dayOfMonth: 15 } }, acted: true });
    expect(dayOfMonth(container)).toBe("10");
    expect(storedCron(container)).toBe("0 9 10 * *");
  });
});
