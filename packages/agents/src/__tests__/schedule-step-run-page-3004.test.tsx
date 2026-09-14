// @vitest-environment jsdom
//
// READING 2 OF cinatra#3004's live-proof round — THE RUN PAGE'S SCHEDULE STEP
// DRAWS THE RUN'S OWN SCHEDULE.
//
// What the proofs showed: for a run whose schedule was armed on the agent's
// page — no conversation proposal, so no `lifecycle_card_ref` — the run page's
// rail drew "1 Schedule" and selecting it left the detail column empty. The
// step resolved the schedule through the conversation's proposal, which such a
// run never had.
//
// THE STEP IS THE SAME ADAPTER, ON THE SAME REF, THROUGH THE SAME RESOLVER as
// the run's own schedule surface: a run-scoped ref, read back off
// `agent_run_triggers`. The road that armed the schedule does not change what
// is drawn — only the state does. That resolver branch is pinned on the server
// side in `schedule-over-3004.test.ts` ("resolveProposalForRun for a run whose
// schedule came from its own scheduling step"); this file is the same reading
// on the run page's own step, in the four states the plan names.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/schedule-step-run-page-3004.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { ScheduleStepSurface } from "../schedule-rail-step";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The ref the run page mints: the RUN, never a proposal token. */
const RUN_REF = "run-scoped-ref-3004";

const RECURRING: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-3004",
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

const ONE_OFF_AHEAD: TriggerScheduleProposalViewBody = {
  ...RECURRING,
  schedule: { kind: "scheduled", runAt: "2099-01-01T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "On 1 January 2099 at 9:00 AM",
  canCancel: false,
};

const ONE_OFF_FIRED: TriggerScheduleProposalViewBody = {
  ...ONE_OFF_AHEAD,
  released: true,
  canSave: false,
  canCancel: false,
};

const RECURRING_CANCELLED: TriggerScheduleProposalViewBody = {
  ...RECURRING,
  stopped: true,
  canSave: false,
  canCancel: false,
};

// THE FIRED READING RIDES THE ANSWER, BESIDE THE BODY (cinatra#3174 fix leg 1).
// A one-off's gate stamp is no longer read as its firing on its own: the run
// the gate opened over has to have actually run, which only the server can say,
// so the resolver's answer carries the reading. These fixtures have always used
// `released: true` on a NON-recurring settled body to mean "this schedule
// fired", so the mock states that reading exactly where the fixture means it.
function firedAside(body: unknown): { firedOnce?: true } {
  const b = body as {
    phase?: string;
    released?: boolean;
    triggerType?: string;
  } | null;
  return b !== null &&
    b.phase === "settled" &&
    b.released === true &&
    b.triggerType !== "recurring"
    ? { firedOnce: true }
    : {};
}

function mountStep(body: TriggerScheduleProposalViewBody) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body,
          ...firedAside(body),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const rendered = render(
    <ScheduleStepSurface host="run_card" cardRef={RUN_REF} promptWindowTemplateId={null} />,
  );
  return { ...rendered, fetchMock };
}

const rows = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-option-rows"]');
const floor = (root: HTMLElement) =>
  root.querySelector('[data-conformance-id="schedule-proposal-floor"]');
const control = (root: HTMLElement, action: string) =>
  root.querySelector(`[data-action="${action}"]`);

describe("the run page's schedule step, on a run that no proposal created", () => {
  it("addresses the schedule by the RUN — the same ref the run's schedule surface uses", async () => {
    const { container, fetchMock } = mountStep(RECURRING);
    await waitFor(() => expect(rows(container)).toBeTruthy());
    const sent = fetchMock.mock.calls[0][1];
    expect(String(sent?.body)).toContain(RUN_REF);
  });

  it("a one-off still ahead of its instant: the rows as they stand, editable, Save changes", async () => {
    const { container } = mountStep(ONE_OFF_AHEAD);
    await waitFor(() => expect(rows(container)).toBeTruthy());
    expect(floor(container)).toBeTruthy();
    expect(control(container, "save-schedule-changes")).toBeTruthy();
    expect(control(container, "cancel-trigger-schedule")).toBeNull();
  });

  it("a recurring schedule after its first fire: editable, Save changes AND Cancel schedule", async () => {
    const { container } = mountStep(RECURRING);
    await waitFor(() => expect(rows(container)).toBeTruthy());
    expect(control(container, "save-schedule-changes")).toBeTruthy();
    expect(control(container, "cancel-trigger-schedule")).toBeTruthy();
  });

  it("a fired one-off: the rows read-only, and no controls at all", async () => {
    const { container } = mountStep(ONE_OFF_FIRED);
    await waitFor(() => expect(rows(container)).toBeTruthy());
    expect(floor(container)).toBeNull();
    expect(control(container, "save-schedule-changes")).toBeNull();
    expect(control(container, "cancel-trigger-schedule")).toBeNull();
  });

  it("a recurring schedule cancelled after a fire: the same ending, on this surface too", async () => {
    const { container } = mountStep(RECURRING_CANCELLED);
    await waitFor(() => expect(rows(container)).toBeTruthy());
    expect(floor(container)).toBeNull();
    expect(container.textContent).not.toContain("Trigger configuration");
    expect(container.textContent).not.toContain("Cancel trigger");
  });
});
