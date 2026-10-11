// @vitest-environment jsdom
//
// THE SAME-SESSION SETTLE (cinatra#2853, the picture leg).
//
// The defect these cases pin, in the words of the capture that recorded it: a
// typed approve resolved the gate — disposition `approve`, `resolved_by` the
// signed-in person — and for the rest of that page session the card kept
// drawing `data-lifecycle-card-state="pending"` with Approve and Reject
// pressable over a resolved gate. Re-opening the thread drew it settled. The
// write was never in question; the drawn card was.
//
// Plan (A) §4.1: after the decision "the card says in place what it did". A
// card still offering a terminal decision over a gate that is already resolved
// says the opposite of that, so the state is pinned here rather than left to
// the resolve cadence that produced it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import {
  LifecycleCardSettleProvider,
  LifecycleCardSurfaceProvider,
  createLifecycleCardSettleBus,
} from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-settle-001",
};

/** The resolve, answering a DIFFERENT state on each successive call — the shape
 *  the live page is in: pending while the person types, settled once the
 *  decision has landed on the server. */
function mockResolveSequence(states: LifecycleCardState[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const state = states[Math.min(call, states.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("a decided card settles WITHOUT a re-open", () => {
  it("re-resolves and draws settled the moment the decision is announced", async () => {
    const fetchMock = mockResolveSequence([
      { state: "pending", canDecide: true, canComment: true },
      { state: "settled" },
    ]);
    const bus = createLifecycleCardSettleBus();
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSettleProvider bus={bus}>
          <ReviewGateCard view={VIEW} />
        </LifecycleCardSettleProvider>
      </LifecycleCardSurfaceProvider>,
    );

    // The state the capture recorded before the send: pending, with the floor.
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );
    const callsWhilePending = fetchMock.mock.calls.length;

    // The decision lands somewhere other than this card's own button — a typed
    // approve, in this same page session, with no reload and no re-open.
    await act(async () => {
      bus.announceSettled(VIEW.ref);
    });

    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-lifecycle-card-state="pending"]')).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhilePending);
  });

  it("leaves a card the announcement does not name exactly where it was", async () => {
    mockResolveSequence([{ state: "pending", canDecide: true, canComment: true }]);
    const bus = createLifecycleCardSettleBus();
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSettleProvider bus={bus}>
          <ReviewGateCard view={VIEW} />
        </LifecycleCardSettleProvider>
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );
    await act(async () => {
      bus.announceSettled("ref-some-other-card");
    });
    expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull();
  });
});

describe("the bus itself", () => {
  it("counts per ref, and an empty ref is not an address", () => {
    const bus = createLifecycleCardSettleBus();
    expect(bus.settledAt("a")).toBe(0);
    bus.announceSettled("a");
    bus.announceSettled("a");
    expect(bus.settledAt("a")).toBe(2);
    expect(bus.settledAt("b")).toBe(0);
    bus.announceSettled("");
    expect(bus.settledAt("")).toBe(0);
  });

  it("tells its subscribers, and stops when they leave", () => {
    const bus = createLifecycleCardSettleBus();
    const heard = vi.fn();
    const stop = bus.subscribe(heard);
    bus.announceSettled("a");
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    bus.announceSettled("a");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
