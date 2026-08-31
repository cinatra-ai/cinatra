// @vitest-environment jsdom
//
// THE SCHEDULE CARD BINDS THE PROMPT WINDOW, LIKE EVERY OTHER LIFECYCLE CARD
// (cinatra#2853, the picture leg; plan (A) §2.2 — "the prompt window acts on
// the ACTIVE card ... with a schedule card, 'make it 8 in the morning on
// weekdays'").
//
// The defect these cases pin, in the words of the capture that recorded it: the
// person typed `make it 8 in the morning on weekdays` at a live schedule card
// and NO grant was minted and no decide row was written. The assistant answered
// the only way left to it — it called the PRODUCER a second time and drew a NEW
// 08:00 card below the 09:00 one, leaving the stale card live with its own
// Confirm, so the schedule the person asked to change could still be confirmed.
//
// The whole cause was here: the claim a send carries is built out of the refs
// cards REGISTER with the composer store, and only the review card registered.
// The server road — the schedule card lends `adjust`, the grant carries it, the
// decide road presses it through the card's own entry — was already complete
// and simply unreachable from a conversation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import {
  LifecycleCardSurfaceProvider,
  LifecycleComposerFocusProvider,
  createComposerFocusStore,
} from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "proposal-ref-bound",
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

function proposalBody(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "proposal" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "proposal",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule: RECURRING,
    durationCopy: "45s–3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
    ...over,
  };
}

const SETTLED_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-777",
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

function mockResolve(state: LifecycleCardState, body: TriggerScheduleProposalViewBody | null) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "trigger_schedule_proposal", state, body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderBound(state: LifecycleCardState, body: TriggerScheduleProposalViewBody | null) {
  const store = createComposerFocusStore();
  const rendered = render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <LifecycleComposerFocusProvider store={store}>
        <ScheduleProposalCard view={VIEW} />
      </LifecycleComposerFocusProvider>
    </LifecycleCardSurfaceProvider>,
  );
  return { store, ...rendered };
}

describe("a live schedule card is in the claim a send carries", () => {
  it("registers its ref as eligible, so a lone schedule card binds with no press", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { store } = renderBound(
      { state: "pending", canDecide: true, canComment: false },
      proposalBody(),
    );
    await waitFor(() => expect(store.getSnapshot().eligible).toContain(VIEW.ref));
    // A LONE eligible card is the bound card, with no press at all — the same
    // rule §2.1 states for a lone review, applied to every kind.
    expect(store.getSnapshot().eligible).toEqual([VIEW.ref]);
  });

  it("registers NO comment road — this card's typed road is the grant, not a comment", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { store } = renderBound(
      { state: "pending", canDecide: true, canComment: false },
      proposalBody(),
    );
    await waitFor(() => expect(store.getSnapshot().eligible).toContain(VIEW.ref));
    expect(store.getCommentAction(VIEW.ref)).toBeUndefined();
  });

  it("an EXPIRED proposal still binds — it keeps a live floor (plan §7.2 step 2)", async () => {
    const expired: TriggerScheduleProposalViewBody = {
      phase: "expired",
      version: 1,
      agentName: "Weekly cohort sweep",
      schedule: RECURRING,
      scheduleCopy: "Every weekday at 9:00 AM",
    };
    mockResolve({ state: "pending", canDecide: true, canComment: false }, expired);
    const { store } = renderBound(
      { state: "pending", canDecide: true, canComment: false },
      expired,
    );
    await waitFor(() => expect(store.getSnapshot().eligible).toContain(VIEW.ref));
  });
});

describe("a card that offers no decision lends none", () => {
  it("a SETTLED card registers nothing — there is no proposal left to change", async () => {
    mockResolve({ state: "settled" }, SETTLED_BODY);
    const { store, container } = renderBound({ state: "settled" }, SETTLED_BODY);
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card]')).not.toBeNull(),
    );
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("a RESTRICTED reader registers nothing — they may see it and not confirm it", async () => {
    const state: LifecycleCardState = {
      state: "restricted",
      canDecide: false,
      canComment: false,
      reason: "You can't confirm this schedule.",
    };
    mockResolve(state, proposalBody({ canConfirm: false }));
    const { store, container } = renderBound(state, proposalBody({ canConfirm: false }));
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card]')).not.toBeNull(),
    );
    expect(store.getSnapshot().eligible).toEqual([]);
  });
});
