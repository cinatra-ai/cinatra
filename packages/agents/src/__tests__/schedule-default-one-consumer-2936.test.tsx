// @vitest-environment jsdom
/**
 * THE SCHEDULE DEFAULT HAS A CONSUMER, AND IS STATED ONCE (cinatra#2936,
 * epic #2926 W6).
 *
 * Plan (B) §3: the schedule moment is "decided from … the coordinator's own
 * default, stated below — not an organization rule: run right after setup unless
 * a schedule was stated in the conversation or changed on the screen", and §7's
 * wave 2 row lands "the schedule default in the coordinator". The decision was
 * landed and then consumed by nothing but its own unit test: the scheduling step
 * preselected **Run right after setup** from a `defaultValues` literal of its
 * own, so the same decision was stated twice with nothing keeping the two
 * agreed.
 *
 * WHAT THIS FILE PINS.
 *
 *   1. The row the scheduling step opens on IS the row the decision names —
 *      `scheduleScreenSelection`, which applies `scheduleDefaultForLaunch`.
 *   2. A schedule the person stated is filled into the form's OWN rows, from
 *      that same answer. A form that ignored the decision and kept a literal
 *      default fails here: it would open on **Run right after setup** with a
 *      schedule stated.
 *   3. "Nobody is present" is a REFUSAL and is honoured as one: no row is
 *      preselected, rather than one invented.
 *   4. Nothing visible changes for the ordinary case — a person present who
 *      stated nothing still opens on **Run right after setup**. The render
 *      tests that have always pinned that (`trigger-form.test.tsx`,
 *      `instance-screens-trigger-step-after-approval.test.tsx`,
 *      `setup-run-surface-rail.test.tsx`) are unchanged and still pass; this
 *      file adds the reading that says WHERE that row now comes from.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  scheduleDefaultForLaunch,
  scheduleScreenSelection,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

// The shipped step uses the app's Select. The shared ui stub passes it through
// without the `onValueChange` wiring, which is all this file needs — it reads
// selections, it does not drive them.
vi.mock("@/components/ui/select", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const React = await import("react");
  function Select(props: { children?: React.ReactNode }) {
    return React.createElement("div", null, props.children);
  }
  function SelectTrigger(props: { children?: React.ReactNode }) {
    return React.createElement("button", { type: "button" }, props.children);
  }
  function SelectContent(props: { children?: React.ReactNode }) {
    return React.createElement("div", null, props.children);
  }
  function SelectItem(props: { children?: React.ReactNode; value: string }) {
    return React.createElement("button", { type: "button" }, props.children);
  }
  function SelectValue(props: { placeholder?: string }) {
    return React.createElement("span", null, props.placeholder);
  }
  return { ...actual, Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

import {
  TriggerScreenClient,
  scheduleFormDefaults,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";

const IMMEDIATE = "Run right after setup";
const SCHEDULED = "Schedule for later";
const RECURRING = "Recurring";

const STATED_ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2031-03-04T09:30",
  timezone: "Europe/Berlin",
};

const STATED_RECURRING: ProposedSchedule = {
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 1,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 8,
    minute: 0,
  },
};

function renderStep(overrides: Partial<TriggerScreenClientProps> = {}) {
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...overrides,
  };
  return render(<TriggerScreenClient {...props} />);
}

/** The option row a label sits in — the bordered row itself, not its inner
 *  layout div, so "which row is chosen" is read off the one element that
 *  carries the chosen edge. */
function row(label: string): HTMLElement | null {
  return screen.getByText(label).closest(".rounded-control") as HTMLElement | null;
}

function chosen(label: string): boolean {
  return (row(label)?.className ?? "").includes("border-primary");
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// The decision, and the one mapping from it to a row
// ---------------------------------------------------------------------------

describe("the row the schedule screen opens on comes from the decision", () => {
  it("a person present who stated nothing: the immediate row — the decision's own answer", () => {
    expect(scheduleDefaultForLaunch({ humanPresent: true })).toEqual({
      kind: "run_after_setup",
    });
    expect(scheduleScreenSelection({ humanPresent: true })).toEqual({ kind: "immediate" });
  });

  it("a schedule stated in the conversation is the row, unchanged", () => {
    expect(scheduleScreenSelection({ humanPresent: true, statedSchedule: STATED_ONE_OFF })).toEqual(
      STATED_ONE_OFF,
    );
    expect(
      scheduleScreenSelection({ humanPresent: true, statedSchedule: STATED_RECURRING }),
    ).toEqual(STATED_RECURRING);
  });

  it("nobody present is a REFUSAL — no row, and not the immediate one", () => {
    expect(scheduleDefaultForLaunch({ humanPresent: false }).kind).toBe("none");
    expect(scheduleScreenSelection({ humanPresent: false })).toBeNull();
    // Even with a schedule in hand: a run nobody is present for is not offered
    // the screen at all, and the schedule it was given applies.
    expect(
      scheduleScreenSelection({ humanPresent: false, statedSchedule: STATED_ONE_OFF }),
    ).toBeNull();
  });

  it("the form's values are that row, and a refusal names no row at all", () => {
    expect(scheduleFormDefaults({ kind: "immediate" }, "UTC")).toEqual({
      triggerType: "immediate",
      timezone: "UTC",
    });
    expect(scheduleFormDefaults(STATED_ONE_OFF, "UTC")).toEqual({
      triggerType: "scheduled",
      scheduledAt: "2031-03-04T09:30",
      timezone: "Europe/Berlin",
    });
    expect(scheduleFormDefaults(STATED_RECURRING, "UTC")).toEqual({
      triggerType: "recurring",
      cronExpression: "0 8 * * 1,2,3,4,5",
      timezone: "Europe/Berlin",
    });
    expect(scheduleFormDefaults(null, "UTC")).toEqual({ timezone: "UTC" });
  });
});

// ---------------------------------------------------------------------------
// The screen — the consumer
// ---------------------------------------------------------------------------

describe("the scheduling step draws the row the decision named", () => {
  it("NO VISIBLE CHANGE for a person present who stated nothing: Run right after setup", () => {
    renderStep();
    expect(chosen(IMMEDIATE)).toBe(true);
    expect(chosen(SCHEDULED)).toBe(false);
    expect(chosen(RECURRING)).toBe(false);
    // And it is the row the decision names, not a coincidence of this screen's.
    expect(scheduleScreenSelection({ humanPresent: true })).toEqual({ kind: "immediate" });
  });

  it("a STATED one-off opens on Schedule for later, at the stated moment", () => {
    // THE MUTATION THIS FILE EXISTS FOR. A screen holding a default of its own
    // opens on the immediate row here, whatever the person stated.
    renderStep({ statedSchedule: STATED_ONE_OFF });
    expect(chosen(SCHEDULED)).toBe(true);
    expect(chosen(IMMEDIATE)).toBe(false);
    const runAt = screen.getByLabelText("Run at") as HTMLInputElement;
    expect(runAt.value).toBe("2031-03-04T09:30");
  });

  it("a STATED recurring schedule opens on Recurring", () => {
    renderStep({ statedSchedule: STATED_RECURRING });
    expect(chosen(RECURRING)).toBe(true);
    expect(chosen(IMMEDIATE)).toBe(false);
  });

  it("a run nobody is present for gets NO selection — the refusal, drawn", () => {
    renderStep({ humanPresent: false });
    expect(chosen(IMMEDIATE)).toBe(false);
    expect(chosen(SCHEDULED)).toBe(false);
    expect(chosen(RECURRING)).toBe(false);
    // The rows are still there — this is a screen with nothing preselected, not
    // a screen with a row invented for a run that should not have reached it.
    expect(screen.getByText(IMMEDIATE)).toBeTruthy();
  });

  it("an unrecorded presence stamp reads as present — the run page's own reading", () => {
    // `humanPresent` on the run row is `boolean | null`: `null` records nothing
    // rather than recording absence, and the run page passes `!== false`.
    renderStep({ humanPresent: undefined });
    expect(chosen(IMMEDIATE)).toBe(true);
  });
});
