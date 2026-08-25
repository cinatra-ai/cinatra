// @vitest-environment jsdom
//
// POINT 5 OF cinatra#2972 — THE RUN PAGE'S SCHEDULE STEP AFTER A RECURRING FIRE.
//
// Two sentences, from PLAN: Agents Lifecycle (A) §7.2 as amended 2026-08-25:
//
//   "The run page's prompt window shows below the scheduler."
//
// and the issue's own wording of the half the plan already carried in §7.2 step
// 5: "On the run page the Schedule step stays clickable/reachable after a
// recurring fire" — the rail row is a row, not a settled/muted reading, for a
// recurring schedule that can still change.
//
// WHAT IS PINNED, AND WHY IT IS PINNED AS DOM. Both halves were unmeasurable
// from source: "reachable" is whether the row still accepts a press once the
// run detail has opened on something else, and "below the scheduler" is which
// container the window is a descendant of — the shipped prompt window portals
// to wherever its parent points it, so a mount that merely EXISTS proves
// nothing about where it lands.
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/schedule-step-prompt-window.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { ScheduleRailStep } from "../schedule-rail-step";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A RECURRING schedule that has fired once — the state the point is about.
 *  `released` stays false (a tick opens the copy's gate, never this run's) and
 *  `canCancel` is the resolver's reading of the tick's own stamp. */
const FIRED_RECURRING: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-777",
  schedule: {
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
      hour: 9,
      minute: 0,
    },
  },
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  arming: false,
  canSave: true,
  canCancel: true,
};

function mockResolve(body = FIRED_RECURRING) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function mount(over: Record<string, unknown> = {}) {
  return render(
    <ScheduleRailStep
      host="run_card"
      cardRef="run-scoped-ref"
      displayStep={1}
      rail={<div data-testid="page-rail-rows" />}
      detail={<div data-testid="run-detail">Agentic Run Progress</div>}
      promptWindowTemplateId="tmpl-1"
      {...over}
    />,
  );
}

const railRow = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-rail-step"]') as HTMLElement | null;
const stepDetail = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-step-detail"]') as HTMLElement | null;
const promptWindow = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-prompt-window"]') as HTMLElement | null;

describe("the Schedule step stays clickable after a recurring fire", () => {
  it("the rail row is a live control, not a settled or muted reading", async () => {
    mockResolve();
    const { container } = mount();
    const row = railRow(container);
    expect(row).not.toBeNull();
    // A row that can be pressed: a real button, not disabled, not aria-disabled.
    expect(row!.tagName.toLowerCase()).toBe("button");
    expect(row!.hasAttribute("disabled")).toBe(false);
    expect(row!.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("…and it is still reachable once the run detail has opened on something else", async () => {
    mockResolve();
    // `initialSelection="detail"` is what the run page passes once the run has
    // an execution record — the state a recurring fire can leave behind.
    const { container, getByTestId } = mount({ initialSelection: "detail" });
    expect(getByTestId("run-detail")).not.toBeNull();
    expect(stepDetail(container)).toBeNull();
    // The row is not marked as the selected step, and it still takes a press…
    expect(railRow(container)!.getAttribute("data-schedule-step-selected")).toBe("false");
    fireEvent.click(railRow(container)!);
    // …which opens the schedule step on the right.
    await waitFor(() => expect(stepDetail(container)).not.toBeNull());
    expect(railRow(container)!.getAttribute("data-schedule-step-selected")).toBe("true");
    expect(railRow(container)!.getAttribute("aria-current")).toBe("step");
  });
});

describe("the prompt window shows BELOW the scheduler", () => {
  it("is mounted inside the schedule step's own detail, under the card", async () => {
    mockResolve();
    const { container } = mount();
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="schedule-option-rows"]'),
      ).not.toBeNull(),
    );
    const window_ = promptWindow(container);
    expect(window_).not.toBeNull();
    // IN THE RUN DETAIL COLUMN, not in the rail and not at the end of the page.
    const detailColumn = container.querySelector('[data-conformance-id="run-detail-column"]')!;
    expect(detailColumn.contains(window_!)).toBe(true);
    expect(stepDetail(container)!.contains(window_!)).toBe(true);
    expect(
      container
        .querySelector('[data-conformance-id="run-step-rail-column"]')!
        .contains(window_!),
    ).toBe(false);
  });

  it("BELOW, in document order — the card comes first", async () => {
    mockResolve();
    const { container } = mount();
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-proposal-card"]')).not.toBeNull(),
    );
    const card = container.querySelector('[data-conformance-id="schedule-proposal-card"]')!;
    const window_ = promptWindow(container)!;
    // DOCUMENT_POSITION_FOLLOWING === 4: the window follows the card.
    expect(card.compareDocumentPosition(window_) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("carries the panel itself, not an empty mount", async () => {
    mockResolve();
    const { container } = mount();
    await waitFor(() => expect(promptWindow(container)).not.toBeNull());
    // `data-conv-open` is the shipped panel's own root attribute, so this is
    // the panel having PORTALLED INTO this mount rather than a div that merely
    // exists.
    await waitFor(() =>
      expect(promptWindow(container)!.querySelector("[data-conv-open]")).not.toBeNull(),
    );
  });

  it("is NOT drawn where the plan does not put it — a host that passes no template", async () => {
    mockResolve();
    const { container } = mount({ promptWindowTemplateId: null });
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="schedule-option-rows"]'),
      ).not.toBeNull(),
    );
    expect(promptWindow(container)).toBeNull();
  });

  // cinatra#2972, codex round 2. `ScheduleProposalCard` draws NO DOM for a run
  // its resolver answers `absent` for — a run whose schedule was set on the
  // run's own scheduling step rather than stated in a conversation. That empty
  // step is a pre-existing gap; what this slice must not do is put a prompt
  // window alone in it, prompting about a form that is not there. "The run
  // page's prompt window shows below the scheduler" — so no scheduler, no
  // window.
  it("is NOT drawn when the card resolves ABSENT and there is no scheduler to be below", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            kind: "trigger_schedule_proposal",
            state: { state: "absent" },
            body: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const { container } = mount();
    // The step itself is still there — the rail row and its column are the
    // page's, not the card's.
    expect(stepDetail(container)).not.toBeNull();
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="schedule-proposal-card"]'),
      ).toBeNull(),
    );
    expect(promptWindow(container)).toBeNull();
  });
});
