// @vitest-environment jsdom
//
// ONE PRESS, ONE MEANING, ON A RUN THAT IS ALREADY WAITING (cinatra#3044).
//
// The pending phase draws the same rows and the same one Confirm whichever
// subject it is holding, and that is right: the person is answering "When should
// this run?" either way. What differs is the ROAD the press takes, and it has to,
// because the two subjects are not the same thing:
//
//   · A PROPOSAL is a single-use token and no run exists yet, so an EDITED
//     Confirm re-proposes and confirms the replacement — two requests, on the
//     new ref, which is what stops the reader arming the schedule they had just
//     corrected away from.
//   · A WAITING RUN has no token to re-mint and no run to create. Its Confirm is
//     ONE request carrying the rows, straight onto the run-trigger path. Sending
//     the composite at it would ask a re-propose of a proposal that never
//     existed, and the press would die on the first leg.
//
// Both conversation hosts are driven — the chat and a third-party application —
// because the card is one component under one contract on both, and the widget's
// request must still travel on the surface's OWN credential.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The run-scoped ref the outbox wrote into the run's own turn. */
const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "a-run-scoped-schedule-ref",
};

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: false };

/** The waiting run's body: the schedule moment's own default row, and the marker. */
function waitingBody(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "proposal" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "proposal",
    version: 1,
    agentName: "Draft Writer",
    schedule: { kind: "immediate" },
    durationCopy: null,
    canConfirm: true,
    restrictedReason: null,
    runPending: true,
    ...over,
  };
}

/** The same body WITHOUT the marker — a proposal token's pending card. */
function proposalBody(): TriggerScheduleProposalViewBody {
  return {
    phase: "proposal",
    version: 1,
    agentName: "Draft Writer",
    schedule: { kind: "immediate" },
    durationCopy: null,
    canConfirm: true,
    restrictedReason: null,
  };
}

function mockTransport(
  body: TriggerScheduleProposalViewBody,
  outcome: unknown = { kind: "confirmed", runId: "run-3044", alreadyConfirmed: false },
) {
  // The state ladder follows the body: a settled body is never drawn under a
  // pending floor, which is the epic's own rule about resolving the two together.
  const state: LifecycleCardState = body.phase === "settled" ? { state: "settled" } : PENDING;
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    return new Response(
      JSON.stringify(
        isDecision ? { outcome } : { kind: "trigger_schedule_proposal", state, body },
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

function renderOn(host: "chat_thread" | "site_widget") {
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

function decisionBodies(
  fetchMock: ReturnType<typeof mockTransport>,
): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter((b): b is string => typeof b === "string" && b.includes('"op"'))
    .map((b) => JSON.parse(b) as Record<string, unknown>);
}

/** What the run's schedule reads back as once Confirm has armed it. */
function settledBody(): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Draft Writer",
    runId: "run-3044",
    schedule: { kind: "scheduled", runAt: "2030-01-01T09:00", timezone: "Europe/Berlin" },
    triggerType: "scheduled",
    scheduleCopy: "Once, at 2030-01-01 09:00 UTC",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    canCancel: false,
  };
}

/**
 * A transport that answers the WAITING body until the press lands, and the
 * SETTLED one afterwards — which is what the server really does: the card takes
 * nothing on trust from its own decision and re-resolves.
 */
function mockSettlingTransport() {
  let armed = false;
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes('"op"')) {
      armed = true;
      return new Response(
        JSON.stringify({
          outcome: { kind: "confirmed", runId: "run-3044", alreadyConfirmed: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        kind: "trigger_schedule_proposal",
        state: armed ? { state: "settled" } : PENDING,
        body: armed ? settledBody() : waitingBody(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

for (const host of ["chat_thread", "site_widget"] as const) {
  describe(`the waiting run's card on ${host}`, () => {
    it("draws the scheduler form, editable, with the one Confirm floor", async () => {
      mockTransport(waitingBody());
      const { container } = renderOn(host);

      await waitFor(() =>
        expect(
          container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      expect(container.querySelectorAll("[data-schedule-option]")).toHaveLength(3);
      expect(
        container.querySelector('[data-schedule-option="immediate"]')?.getAttribute("data-chosen"),
      ).toBe("true");
      expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull();
      // ONE card root, on this host, for this kind.
      expect(
        container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ).toHaveLength(1);
    });

    it("sends ONE confirm carrying the rows — never the proposal's re-propose composite", async () => {
      const fetchMock = mockTransport(waitingBody());
      const { container } = renderOn(host);

      await waitFor(() =>
        expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull(),
      );
      fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

      await waitFor(() => expect(decisionBodies(fetchMock).length).toBeGreaterThan(0));
      const bodies = decisionBodies(fetchMock);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].op).toBe("confirm");
      expect(bodies[0].ref).toBe(VIEW.ref);
      // The rows travel WITH the press — an unedited one carries what the card
      // was drawn on, so the server never has to guess what the reader saw.
      expect(bodies[0].schedule).toEqual({ kind: "immediate" });
    });

    it("SETTLES IN PLACE on that same card — the armed schedule, in the same rows", async () => {
      const fetchMock = mockSettlingTransport();
      const { container } = renderOn(host);

      await waitFor(() =>
        expect(container.querySelector('[data-schedule-option="scheduled"] button')).not.toBeNull(),
      );
      // A SCHEDULE, not the default immediate row — a schedule is what there is
      // to settle INTO. "Run right after setup" arms nothing to come back to:
      // it dispatches the run, and the ratified reading of that card is pinned
      // separately below rather than papered over with a fabricated body.
      fireEvent.click(container.querySelector('[data-schedule-option="scheduled"] button')!);
      fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

      await waitFor(() => expect(decisionBodies(fetchMock).length).toBe(1));
      expect((decisionBodies(fetchMock)[0].schedule as { kind: string }).kind).toBe("scheduled");

      // NO SECOND CARD. The same root re-resolves into the trigger's chrome.
      await waitFor(() =>
        expect(
          container
            .querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')
            ?.getAttribute("data-lifecycle-card-phase"),
        ).toBe("settled"),
      );
      expect(
        container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ).toHaveLength(1);
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull();
      // The confirm floor is gone — the decision has been made.
      expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).toBeNull();
    });

    it("is STILL THERE after a reload, drawn from the turn's durable reference", async () => {
      // The reload rebuilds the transcript from the store and mounts the card at
      // the same durable ref; the state is re-resolved server-side, so what is
      // drawn is the armed schedule rather than anything the first mount kept.
      mockTransport(settledBody() as TriggerScheduleProposalViewBody, undefined);
      const { container } = renderOn(host);

      await waitFor(() =>
        expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).not.toBeNull(),
      );
      const card = container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')!;
      expect(card.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(card.getAttribute("data-lifecycle-card-phase")).toBe("settled");
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull();
    });

    it("follows the ratified reading for RUN RIGHT AFTER SETUP: the run starts and the card asks nothing more", async () => {
      // "Run right after setup" names no moment to open a schedule step onto —
      // it starts the run — so once it is confirmed the run is no longer waiting
      // and the resolver answers `absent` for it (the reading cinatra#3004
      // ratified and this change leaves exactly as it found it). §IV: an absent
      // card draws NO DOM at all, and the conversation's run card carries the
      // run from there.
      let armed = false;
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const raw = typeof init?.body === "string" ? init.body : "";
        if (raw.includes('"op"')) {
          armed = true;
          return new Response(
            JSON.stringify({
              outcome: { kind: "confirmed", runId: "run-3044", alreadyConfirmed: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify(
            armed
              ? { kind: "trigger_schedule_proposal", state: { state: "absent" }, body: null }
              : { kind: "trigger_schedule_proposal", state: PENDING, body: waitingBody() },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { container } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull(),
      );
      fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

      // The press carried the DEFAULT row, untouched.
      await waitFor(() => expect(decisionBodies(fetchMock).length).toBe(1));
      expect(decisionBodies(fetchMock)[0].schedule).toEqual({ kind: "immediate" });
      // …and the card is gone, with no floor and no half-drawn shell left behind.
      await waitFor(() =>
        expect(
          container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]'),
        ).toBeNull(),
      );
      expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).toBeNull();
    });

    it("sends the EDITED rows on that same one press", async () => {
      const fetchMock = mockTransport(waitingBody());
      const { container } = renderOn(host);

      await waitFor(() =>
        expect(container.querySelector('[data-schedule-option="recurring"] button')).not.toBeNull(),
      );
      fireEvent.click(container.querySelector('[data-schedule-option="recurring"] button')!);
      fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

      await waitFor(() => expect(decisionBodies(fetchMock).length).toBeGreaterThan(0));
      const bodies = decisionBodies(fetchMock);
      // STILL ONE REQUEST. The composite would have sent `adjust` first.
      expect(bodies).toHaveLength(1);
      expect(bodies[0].op).toBe("confirm");
      expect((bodies[0].schedule as { kind: string }).kind).toBe("recurring");
    });
  });
}

describe("the proposal token's card is untouched", () => {
  it("still re-proposes before it confirms an EDITED proposal", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw.includes('"op":"adjust"')) {
        return new Response(
          JSON.stringify({ outcome: { kind: "reproposed", ref: "next-ref", expiresAt: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (raw.includes('"op"')) {
        return new Response(
          JSON.stringify({
            outcome: { kind: "confirmed", runId: "run-777", alreadyConfirmed: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: PENDING,
          body: proposalBody(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-schedule-option="recurring"] button')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-schedule-option="recurring"] button')!);
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

    await waitFor(() => expect(decisionBodies(fetchMock).length).toBe(2));
    const bodies = decisionBodies(fetchMock);
    expect(bodies[0].op).toBe("adjust");
    expect(bodies[1].op).toBe("confirm");
    // …and the confirm went to the REPLACEMENT ref, not the one it started on.
    expect(bodies[1].ref).toBe("next-ref");
  });
});
