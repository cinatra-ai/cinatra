// @vitest-environment jsdom
//
// A PAST OR MISSING RUN AT IS REFUSED ON THE FIELD, BEFORE ANYTHING IS ARMED
// (cinatra#3189, P10), on the scheduling step's own form.
//
// Design `specs/app-components.html`, "Standard scheduling step": "a
// validation failure — a past instant, or a recurring schedule with no time
// chosen — surfaces inline on the field (the error state)", and the error
// state "adds aria-invalid to the input". The Run at is a day button and the
// Hour and Minute comboboxes: a button's role takes no aria-invalid, so the
// comboboxes carry it, the day button is marked `data-invalid`, and all three
// name the sentence. The check is the shared
// `validateScheduleTime`, run when Continue is pressed, in the zone the field
// holds; the server's own check still answers a press that passes here.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-screen-past-time-3189.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

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
import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";

// jsdom ships no ResizeObserver, no pointer capture and no scrollIntoView; the
// app's Select (Radix) and the date picker's popover call them. Test-ENVIRONMENT
// shims only, restored in `afterEach`.
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

function installShims() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

// 2026-07-14 07:00 UTC = 09:00 in Berlin = 00:00 in Los Angeles. Only the
// clock is faked, so the form's own async submit still settles.
const NOW = Date.parse("2026-07-14T07:00:00Z");

const oneOff = (runAt: string, timezone = "Europe/Berlin"): ProposedSchedule => ({
  kind: "scheduled",
  runAt,
  timezone,
});

type Road = "standalone" | "embedded";

function renderForm(
  road: Road,
  overrides: Partial<TriggerScreenClientProps> = {},
): { onSubmit: ReturnType<typeof vi.fn> } {
  installShims();
  const onSubmit = vi.fn(async () => {});
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-3189",
    templateId: "tpl-3189",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...(road === "embedded" ? { embeddedAsRenderer: true, onSubmit } : {}),
    ...overrides,
  };
  render(<TriggerScreenClient {...props} />);
  return { onSubmit };
}

function runAtTrigger(): HTMLElement {
  const el = document.getElementById("scheduledAt");
  if (el === null) throw new Error("no Run at field");
  return el;
}

/** The Run at's error state: the day button marked, the time comboboxes
 *  invalid, and all three naming the one sentence. */
function expectErrorState() {
  const id = runAtTrigger().getAttribute("aria-describedby");
  expect(id).toBe("scheduledAt-error");
  expect(runAtTrigger().hasAttribute("data-invalid")).toBe(true);
  expect(runAtTrigger().hasAttribute("aria-invalid")).toBe(false);
  for (const name of ["Hour", "Minute"]) {
    const box = screen.getByRole("combobox", { name });
    expect(box.getAttribute("aria-invalid"), name).toBe("true");
    expect(box.getAttribute("aria-describedby"), name).toBe(id);
  }
}

/** No error state on any part of the Run at. */
function expectNoErrorState() {
  expect(runAtTrigger().hasAttribute("data-invalid")).toBe(false);
  expect(runAtTrigger().hasAttribute("aria-invalid")).toBe(false);
  expect(runAtTrigger().hasAttribute("aria-describedby")).toBe(false);
  for (const name of ["Hour", "Minute"]) {
    const box = screen.queryByRole("combobox", { name });
    if (box === null) continue;
    expect(box.hasAttribute("aria-invalid"), name).toBe(false);
    expect(box.hasAttribute("aria-describedby"), name).toBe(false);
  }
}

/** The sentence the field names as its description, or null. */
function tiedMessage(): string | null {
  const id = runAtTrigger().getAttribute("aria-describedby");
  if (!id) return null;
  return document.getElementById(id)?.textContent ?? null;
}

async function pressContinue() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  });
}

/** Every call either road could have made to arm the schedule. */
function armingCalls(road: Road, onSubmit: ReturnType<typeof vi.fn>): number {
  return road === "embedded" ? onSubmit.mock.calls.length : vi.mocked(setRunTrigger).mock.calls.length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  routerState.push.mockReset();
  routerState.refresh.mockReset();
  vi.mocked(setRunTrigger).mockReset();
  vi.mocked(setRunTrigger).mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  Element.prototype.hasPointerCapture = ORIGINAL_ELEMENT_SHIMS.hasPointerCapture;
  Element.prototype.releasePointerCapture = ORIGINAL_ELEMENT_SHIMS.releasePointerCapture;
  Element.prototype.scrollIntoView = ORIGINAL_ELEMENT_SHIMS.scrollIntoView;
});

describe.each<Road>(["standalone", "embedded"])("Continue on the %s road", (road) => {
  it("refuses a past instant on the field and arms nothing", async () => {
    // 08:00 in Berlin is an hour ago.
    const { onSubmit } = renderForm(road, { statedSchedule: oneOff("2026-07-14T08:00") });
    expectNoErrorState();
    await pressContinue();
    await waitFor(() => expectErrorState());
    expect(tiedMessage()).toBe("Choose a time in the future.");
    expect(armingCalls(road, onSubmit)).toBe(0);
    expect(routerState.refresh).not.toHaveBeenCalled();
    expect(routerState.push).not.toHaveBeenCalled();
  });

  it("refuses an instant exactly at now", async () => {
    const { onSubmit } = renderForm(road, { statedSchedule: oneOff("2026-07-14T09:00") });
    await pressContinue();
    await waitFor(() => expectErrorState());
    expect(tiedMessage()).toBe("Choose a time in the future.");
    expect(armingCalls(road, onSubmit)).toBe(0);
  });

  it("refuses Schedule for later with no day chosen, with the no-time sentence", async () => {
    const { onSubmit } = renderForm(road);
    fireEvent.click(screen.getByText("Schedule for later"));
    await waitFor(() => expect(document.getElementById("scheduledAt")).not.toBeNull());
    await pressContinue();
    await waitFor(() => expectErrorState());
    expect(tiedMessage()).toBe("Choose a time.");
    expect(armingCalls(road, onSubmit)).toBe(0);
  });

  it("arms a future instant exactly once", async () => {
    const { onSubmit } = renderForm(road, { statedSchedule: oneOff("2026-07-14T10:00") });
    await pressContinue();
    await waitFor(() => expect(armingCalls(road, onSubmit)).toBe(1));
    expectNoErrorState();
    if (road === "standalone") {
      expect(vi.mocked(setRunTrigger)).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-3189",
          triggerType: "scheduled",
          scheduledAt: "2026-07-14T10:00",
          timezone: "Europe/Berlin",
        }),
      );
    } else {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ triggerType: "scheduled", scheduledAt: "2026-07-14T10:00" }),
      );
    }
  });

  it("judges the wall clock in the zone the field holds", async () => {
    // 05:00 is past in Berlin and still ahead in Los Angeles.
    const { onSubmit } = renderForm(road, {
      statedSchedule: oneOff("2026-07-14T05:00", "America/Los_Angeles"),
    });
    await pressContinue();
    await waitFor(() => expect(armingCalls(road, onSubmit)).toBe(1));
    expectNoErrorState();
  });

  it("passes Run right after setup and a recurring schedule untouched", async () => {
    const first = renderForm(road);
    await pressContinue();
    await waitFor(() => expect(armingCalls(road, first.onSubmit)).toBe(1));
    cleanup();
    vi.mocked(setRunTrigger).mockClear();
    const second = renderForm(road, {
      statedSchedule: {
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
          hour: 9,
          minute: 0,
        },
      },
    });
    await pressContinue();
    await waitFor(() => expect(armingCalls(road, second.onSubmit)).toBe(1));
  });

  it("clears the error when the reader changes the field", async () => {
    renderForm(road, { statedSchedule: oneOff("2026-07-14T08:00") });
    await pressContinue();
    await waitFor(() => expectErrorState());
    // Open the day picker and choose the next day.
    fireEvent.click(runAtTrigger());
    const day = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-day="2026-07-15"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(day);
    await waitFor(() => expectNoErrorState());
    expect(tiedMessage()).toBeNull();
  });
});

describe("the server still answers a press the client passes", () => {
  it("shows the server's refusal on the standalone road", async () => {
    vi.mocked(setRunTrigger).mockResolvedValue({
      ok: false,
      error: "Scheduled time must be in the future",
    } as never);
    renderForm("standalone", { statedSchedule: oneOff("2026-07-14T10:00") });
    await pressContinue();
    await waitFor(() =>
      expect(screen.getByText("Scheduled time must be in the future")).toBeTruthy(),
    );
    expect(vi.mocked(setRunTrigger)).toHaveBeenCalledTimes(1);
    expectNoErrorState();
  });

  it("shows the parent's refusal on the embedded road", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Scheduled time must be in the future");
    });
    renderForm("embedded", { statedSchedule: oneOff("2026-07-14T10:00"), onSubmit });
    await pressContinue();
    await waitFor(() =>
      expect(screen.getByText("Scheduled time must be in the future")).toBeTruthy(),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("the read-only reading", () => {
  it("submits nothing and draws no error state", async () => {
    renderForm("standalone", { statedSchedule: oneOff("2026-07-14T08:00"), readOnly: true });
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
    const form = document.querySelector("form");
    await act(async () => {
      fireEvent.submit(form!);
    });
    expect(vi.mocked(setRunTrigger)).not.toHaveBeenCalled();
    expectNoErrorState();
  });
});
