// @vitest-environment jsdom
//
// THE AGENT PAGE'S SCHEDULE SURFACE (cinatra#3004).
//
// The plan's words this file is the executable reading of:
//
//   "The schedule surface on the agent's page shows the schedule form itself in
//    its respective state — never a 'Trigger configuration' card — the same form
//    as in the chat and on the run page."
//
//   "A recurring schedule that ran at least once and was then cancelled is over,
//    the same as a run set to run once that already ran: the run is over and
//    nothing in that run can be configured anymore."
//
// WHAT IS PINNED HERE:
//
//   1. THE SURFACE IS THE FORM, in the run's own state — the same
//      `ScheduleProposalCard` the chat thread and the run page's schedule step
//      mount, not a second drawing of the same facts. Three states:
//        · a live recurring schedule that has fired  → editable rows,
//          Save changes, Cancel schedule;
//        · a one-off that has fired                  → the rows, read-only,
//          no floor at all;
//        · a recurring schedule cancelled after a fire → the rows, read-only,
//          no floor, and no route left to re-arm.
//   2. THE RETIRED DRAWING IS GONE from this surface: no "Trigger
//      configuration", no "Steps held until trigger fires", no "Cancel trigger"
//      and no "Cancel scheduled trigger?" dialog. The wording is the
//      schedule's.
// The third property this issue lands — that the two `run_card` adapters are
// exclusive — is pinned in `schedule-run-card-adapters-3004.test.ts`, which
// reads the picker rather than the DOM.
//
// Harness mirrors `schedule-proposal-card.test.tsx`: the card runs for real
// against a mocked resolve/decide transport, so no server and no database.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/schedule-surface-agent-page-3004.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { RunScheduleTab } from "../run-schedule-tab";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RUN_REF = "run-ref-3004";

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

const ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2026-08-24T09:00",
  timezone: "Europe/Berlin",
};

function settledBody(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Weekly cohort sweep",
    runId: "run-3004",
    schedule: RECURRING,
    triggerType: "recurring",
    scheduleCopy: "Every weekday at 9:00 AM",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    canCancel: true,
    ...over,
  };
}

/** The resolve answer in the per-kind envelope the card parses. */
function mockTransport(
  state: LifecycleCardState,
  body: TriggerScheduleProposalViewBody | null,
) {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ kind: "trigger_schedule_proposal", state, body }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The surface as the agent page mounts it. */
function renderSurface() {
  return render(<RunScheduleTab cardRef={RUN_REF} promptWindowTemplateId={null} />);
}

async function surfaceWithRows(
  body: TriggerScheduleProposalViewBody,
): Promise<HTMLElement> {
  mockTransport({ state: "settled" }, body);
  const { container } = renderSurface();
  await waitFor(() =>
    expect(
      container.querySelector('[data-conformance-id="schedule-option-rows"]'),
    ).not.toBeNull(),
  );
  return container;
}

function isDisabled(el: Element | null): boolean {
  return (el as HTMLButtonElement | HTMLInputElement | null)?.disabled === true;
}

// ---------------------------------------------------------------------------
// 1 — the surface IS the schedule form, in the run's state
// ---------------------------------------------------------------------------

describe("the agent page's schedule surface draws the schedule form", () => {
  it("a live recurring schedule that has fired: the editable rows, Save changes and Cancel schedule", async () => {
    const container = await surfaceWithRows(settledBody());

    // The one renderer, addressed by the run — the same card root the chat
    // thread and the run page's schedule step draw.
    expect(
      container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
    ).toHaveLength(1);
    expect(container.querySelectorAll('[data-schedule-option]')).toHaveLength(3);
    // Editable as they stand — the shipped behaviour of the run page's step.
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(
      false,
    );
    expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull();
    expect(
      container.querySelector('[data-action="cancel-trigger-schedule"]')?.textContent,
    ).toContain("Cancel schedule");
  });

  it("a one-off that has FIRED: the rows read-only, and no controls at all", async () => {
    const container = await surfaceWithRows(
      settledBody({
        schedule: ONE_OFF,
        triggerType: "scheduled",
        scheduleCopy: "24 August 2026 at 9:00 AM",
        released: true,
        canSave: false,
        canCancel: false,
      }),
    );

    expect(container.querySelectorAll('[data-schedule-option]')).toHaveLength(3);
    expect(isDisabled(container.querySelector('[data-field="schedule-run-at"]'))).toBe(true);
    // "no controls at all" — not a disabled Save changes, not a disabled
    // Cancel schedule: the floor is not drawn.
    expect(container.querySelector('[data-conformance-id="schedule-proposal-floor"]')).toBeNull();
    expect(container.querySelector('[data-action="save-schedule-changes"]')).toBeNull();
    expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
  });

  it("a recurring schedule CANCELLED after a fire: the rows read-only, no controls, and no way to arm another", async () => {
    const container = await surfaceWithRows(
      settledBody({ stopped: true, canSave: false, canCancel: false }),
    );

    expect(container.querySelectorAll('[data-schedule-option]')).toHaveLength(3);
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(true);
    expect(container.querySelector('[data-conformance-id="schedule-proposal-floor"]')).toBeNull();
    expect(container.querySelector('[data-action="save-schedule-changes"]')).toBeNull();
    expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
    // The three-option form that STARTS a schedule does not take this
    // surface's place — the run is over, so there is nothing here that arms.
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Continue");
  });
});

// ---------------------------------------------------------------------------
// 2 — the retired drawing is gone from this surface
// ---------------------------------------------------------------------------

describe("the retired Trigger-tab drawing is gone from the agent page", () => {
  const STATES: Array<[string, TriggerScheduleProposalViewBody]> = [
    ["a live recurring schedule", settledBody()],
    [
      "a fired one-off",
      settledBody({
        schedule: ONE_OFF,
        triggerType: "scheduled",
        released: true,
        canSave: false,
        canCancel: false,
      }),
    ],
    [
      "a cancelled recurring schedule",
      settledBody({ stopped: true, canSave: false, canCancel: false }),
    ],
  ];

  it.each(STATES)(
    "%s draws no Trigger-configuration card, no held-steps tree and no Cancel trigger",
    async (_name, body) => {
      const container = await surfaceWithRows(body);

      expect(container.textContent).not.toContain("Trigger configuration");
      expect(container.textContent).not.toContain("Steps held until trigger fires");
      expect(container.textContent).not.toContain("Cancel trigger");
      expect(container.textContent).not.toContain("Cancel scheduled trigger?");
      expect(container.querySelector('[data-testid="gated-step-tree"]')).toBeNull();
      expect(container.querySelector('[data-testid="gated-step-tree-empty"]')).toBeNull();
      // The wording of this surface is the schedule's, throughout.
      expect(container.textContent).not.toMatch(/\btrigger\b/i);
    },
  );
});
