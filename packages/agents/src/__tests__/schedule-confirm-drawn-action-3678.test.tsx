// @vitest-environment jsdom
//
// THE SCHEDULE CARD'S CONFIRM CARRIES THE ACTION THE DRAWING NAMES
// (cinatra#3678). Design: design@06230d4e `specs/app-lifecycle-cards.html`
// §VI — the Confirm floor (:842, `schedule-card-confirm-floor`) and the expired
// floor (:978, `schedule-card-expired-floor`) each draw
// `data-action="confirm-schedule -> scheduled"` on the FLOOR, and the Confirm
// button inside it carries no `data-action` of its own.
//
// What is pinned here:
//   1. the live proposal's floor carries the drawn value, exactly;
//   2. the expired proposal's floor carries the same value;
//   3. the Confirm button sits inside that floor and carries no `data-action`;
//   4. the value retired with this change is drawn nowhere on any phase;
//   5. the armed card's floor does not carry the drawn Confirm action.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The drawn value, as specs/app-lifecycle-cards.html:842 and :978 draw it. */
const DRAWN_CONFIRM_ACTION = "confirm-schedule -> scheduled";
/** The value the card shipped before this change. It must not survive. */
const RETIRED_CONFIRM_ACTION = "confirm-schedule-proposal";

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "proposal-ref-3678",
};

const RECURRING: ProposedSchedule = {
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
};

const PROPOSAL: TriggerScheduleProposalViewBody = {
  phase: "proposal",
  version: 1,
  agentName: "Weekly cohort sweep",
  schedule: RECURRING,
  durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true,
  restrictedReason: null,
};

const EXPIRED: TriggerScheduleProposalViewBody = {
  phase: "expired",
  version: 1,
  agentName: "Weekly cohort sweep",
  schedule: RECURRING,
  scheduleCopy: "Every weekday at 9:00 AM",
};

const SETTLED: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-3678",
  schedule: RECURRING,
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  arming: false,
  canSave: true,
  canCancel: true,
};

function answer(state: LifecycleCardState, body: TriggerScheduleProposalViewBody) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "trigger_schedule_proposal", state, body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function renderCard(host: "chat_thread" | "run_card" = "chat_thread"): HTMLElement {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  ).container;
}

async function floorOf(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
    ).not.toBeNull(),
  );
  return container.querySelector('[data-conformance-id="schedule-proposal-floor"]') as HTMLElement;
}

function expectDrawnConfirmFloor(container: HTMLElement, floor: HTMLElement): void {
  // 1 / 2. The floor itself carries the drawn value, exactly.
  expect(floor.getAttribute("data-action")).toBe(DRAWN_CONFIRM_ACTION);
  expect(
    container.querySelectorAll(`[data-action="${DRAWN_CONFIRM_ACTION}"]`),
  ).toHaveLength(1);
  // 3. Confirm is the button INSIDE the floor, and has no action of its own.
  const confirm = within(floor).getByRole("button", { name: /Confirm/ });
  expect(confirm.hasAttribute("data-action")).toBe(false);
  // 4. The retired value is drawn nowhere.
  expect(container.querySelector(`[data-action="${RETIRED_CONFIRM_ACTION}"]`)).toBeNull();
}

describe("cinatra#3678 — the Confirm floor carries the drawn action", () => {
  it("a live proposal's floor carries `confirm-schedule -> scheduled`, and Confirm is its button", async () => {
    answer({ state: "pending", canDecide: true, canComment: false }, PROPOSAL);
    const container = renderCard();
    expectDrawnConfirmFloor(container, await floorOf(container));
  });

  it("an expired proposal's floor carries the same drawn action", async () => {
    // An expired proposal is answered settled, as the card suite answers it.
    answer({ state: "settled" }, EXPIRED);
    const container = renderCard();
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="schedule-proposal-expired"]'),
      ).not.toBeNull(),
    );
    expectDrawnConfirmFloor(container, await floorOf(container));
  });

  it("the armed card's floor does not carry the drawn Confirm action", async () => {
    answer({ state: "settled" }, SETTLED);
    const container = renderCard("run_card");
    const floor = await floorOf(container);
    expect(floor.getAttribute("data-action")).not.toBe(DRAWN_CONFIRM_ACTION);
    expect(container.querySelector(`[data-action="${DRAWN_CONFIRM_ACTION}"]`)).toBeNull();
    expect(container.querySelector(`[data-action="${RETIRED_CONFIRM_ACTION}"]`)).toBeNull();
  });
});
