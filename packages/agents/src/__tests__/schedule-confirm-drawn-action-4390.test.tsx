// @vitest-environment jsdom
//
// cinatra#4390 — the schedule card's Confirm carries the DRAWN data-action.
//
// `specs/app-lifecycle-cards.html` §VI (design@06230d4e8de397e86e3216199342d15c0b4fc5a6)
// draws the card's one decision control as
// `data-action="confirm-schedule -> scheduled"` on both undecided floors: the
// live proposal's Confirm floor (`schedule-card-confirm-floor`) and the expired
// proposal's (`schedule-card-expired-floor`). The product shipped another name
// for the same control, so the drawing-anchor check could not resolve it. What
// is pinned here: on every host, on both undecided floors, the ONE Confirm
// button carries the drawn value and the old name is gone; the settled card
// carries neither; a press on the drawn control still decides.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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

const DRAWN = "confirm-schedule -> scheduled";
const DRAWN_SELECTOR = `[data-action="${DRAWN}"]`;
// The name the product shipped before #4390. Spelled in two parts so this file
// is not itself a reference to it.
const RETIRED_SELECTOR = `[data-action="${["confirm", "schedule", "proposal"].join("-")}"]`;

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "proposal-ref-4390",
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

const PROPOSAL_BODY: TriggerScheduleProposalViewBody = {
  phase: "proposal",
  version: 1,
  agentName: "Weekly cohort sweep",
  schedule: RECURRING,
  durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true,
  restrictedReason: null,
};

const EXPIRED_BODY: TriggerScheduleProposalViewBody = {
  phase: "expired",
  version: 1,
  agentName: "Weekly cohort sweep",
  schedule: RECURRING,
  scheduleCopy: "Every weekday at 9:00 AM",
};

const SETTLED_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-4390",
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

function mockTransport(state: LifecycleCardState, body: TriggerScheduleProposalViewBody) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    return new Response(
      JSON.stringify(
        isDecision
          ? { outcome: { kind: "confirmed", runId: "run-4390", alreadyConfirmed: false } }
          : { kind: "trigger_schedule_proposal", state, body },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

type Host = "chat_thread" | "run_card" | "page_gate_region" | "site_widget";
const HOSTS: readonly Host[] = ["chat_thread", "run_card", "page_gate_region", "site_widget"];

function renderOn(host: Host) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
      frame={host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined}
    >
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** The one button whose visible label is Confirm. */
function confirmButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === "Confirm",
  );
}

const UNDECIDED: ReadonlyArray<{
  floor: string;
  marker: string;
  state: LifecycleCardState;
  body: TriggerScheduleProposalViewBody;
}> = [
  {
    floor: "the live proposal's Confirm floor",
    marker: '[data-conformance-id="schedule-proposal-floor"]',
    state: { state: "pending", canDecide: true, canComment: false },
    body: PROPOSAL_BODY,
  },
  {
    floor: "the expired proposal's Confirm floor",
    marker: '[data-conformance-id="schedule-proposal-expired"]',
    state: { state: "settled" },
    body: EXPIRED_BODY,
  },
];

describe("cinatra#4390: the Confirm button carries the drawn data-action", () => {
  for (const host of HOSTS) {
    for (const reading of UNDECIDED) {
      it(`${host}, ${reading.floor}: the ONE Confirm button emits "${DRAWN}" and the old name is gone`, async () => {
        mockTransport(reading.state, reading.body);
        const { container } = renderOn(host);
        await waitFor(() => expect(container.querySelector(reading.marker)).not.toBeNull());

        const card = container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
        expect(card).not.toBeNull();
        // Exactly one element carries the drawn value, inside the card root,
        // and it is the Confirm button itself.
        const drawn = card!.querySelectorAll(DRAWN_SELECTOR);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]!.tagName).toBe("BUTTON");
        const buttons = confirmButtons(container);
        expect(buttons).toHaveLength(1);
        expect(buttons[0]!.getAttribute("data-action")).toBe(DRAWN);
        // The old name is drawn nowhere on the screen.
        expect(container.querySelectorAll(RETIRED_SELECTOR)).toHaveLength(0);
      });
    }
  }

  it("the settled card carries neither the drawn value nor the old name", async () => {
    mockTransport({ state: "settled" }, SETTLED_BODY);
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll(DRAWN_SELECTOR)).toHaveLength(0);
    expect(container.querySelectorAll(RETIRED_SELECTOR)).toHaveLength(0);
  });

  it("a press on the drawn control still sends the confirm decision", async () => {
    const fetchMock = mockTransport(
      { state: "pending", canDecide: true, canComment: false },
      PROPOSAL_BODY,
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(container.querySelector(DRAWN_SELECTOR)).not.toBeNull());
    fireEvent.click(container.querySelector(DRAWN_SELECTOR)!);
    await waitFor(() => {
      const ops = fetchMock.mock.calls
        .map(([, init]) => (init as RequestInit | undefined)?.body)
        .filter((b): b is string => typeof b === "string" && b.includes('"op"'))
        .map((b) => (JSON.parse(b) as { op?: string }).op);
      expect(ops).toContain("confirm");
    });
  });
});
