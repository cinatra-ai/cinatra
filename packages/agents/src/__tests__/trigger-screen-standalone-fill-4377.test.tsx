// @vitest-environment jsdom
//
// THE STANDALONE FILL ROAD OF THE SCHEDULING STEP (cinatra#4377).
//
// The step applies an assistant fill from two callers: the HITL parent's
// `aiSuggestions` prop (read in trigger-screen-recurrence-selectors-3189) and,
// standalone, this screen's own window: `runWindow.send()` answers a turn, and
// its `fill.values` go through the same `applyScheduleValues`. These drive that
// second caller: the window's conversation hook and its panel are stand-ins, so
// a turn's fill is exactly the values named here.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-standalone-fill-4377.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

// The window's panel stands in as one control that sends a message, the way
// the drawn panel calls `onSubmit` with what the person typed. A span, because
// the design-system gate forbids the bare element in favour of the shadcn
// control (run-window-fill-reaches-setup-field-2934's stand-in).
vi.mock("../hitl-conversation-panel", () => ({
  HitlConversationPanel: (props: { onSubmit: (prompt: string) => unknown }) => (
    <span
      role="button"
      tabIndex={0}
      data-testid="send-in-window"
      onClick={() => void props.onSubmit("change the day")}
    >
      send
    </span>
  ),
}));

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
  return render(<TriggerScreenClient {...props} />);
}

const storedCron = (container: HTMLElement) =>
  (container.querySelector('input[name="cronExpression"]') as HTMLInputElement | null)?.value ?? "";
const dayOfMonth = (container: HTMLElement) =>
  (container.querySelector('[aria-label="Day of month"]') as HTMLElement | null)?.textContent ?? null;

/**
 * One window turn whose effect is `effect`. It resolves only after the turn's
 * answer was awaited and its fill (if any) applied, so a refusal is read after
 * the fill had its chance to land, never before.
 */
async function turn(effect: { fill: { values: Record<string, unknown> } | null; acted: boolean }) {
  windowState.send.mockResolvedValueOnce(effect);
  await act(async () => {
    fireEvent.click(screen.getByTestId("send-in-window"));
    await windowState.send.mock.results[0]?.value;
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
