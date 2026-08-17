// @vitest-environment jsdom
//
// The EXPIRED schedule-proposal reading, drawn.
// Design: `specs/app-lifecycle-cards.html` §VI (the proposal card), §IV (the
// states, and what the undrawn one is reserved for).
//
// §VI: "An expired proposal is not an error state — the card says so and Adjust
// re-proposes for free." The defect: the resolve answered `absent` for it, and
// `absent` is "no card DOM at all" — so the card vanished out of the reader's
// own transcript, with no trace and no way to propose again from it.
//
// What is pinned here is the SURFACE half: the card is on screen, it says the
// proposal expired, Adjust is pressable, and pressing it puts a fresh proposal
// in the card's place. The reader who may not see the subject still gets
// nothing at all — that is the state the empty rendering is reserved for, and
// this change must not have widened it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  adjustExpiredScheduleProposal.mockReset();
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const adjustExpiredScheduleProposal = vi.fn();
vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-actions", () => ({
  adjustExpiredScheduleProposal: (...args: unknown[]) =>
    adjustExpiredScheduleProposal(...args),
}));

import {
  LifecycleCard,
  LifecycleCardSurfaceProvider,
} from "../renderable-views/lifecycle-card";

const EXPIRED_REF = "expired-proposal-ref";
const FRESH_REF = "freshly-proposed-ref";

const PROPOSAL_VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: EXPIRED_REF,
};

const EXPIRED_BODY = {
  phase: "expired",
  version: 1,
  agentName: "Weekly digest",
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
      monthlyWeekday: 0,
      quarterAnchor: "start",
      yearlyMonth: 1,
      hour: 9,
      minute: 0,
    },
  },
  scheduleCopy: "Every weekday at 9:00 AM",
};

const PENDING_BODY = {
  phase: "proposal",
  version: 1,
  agentName: "Weekly digest",
  schedule: EXPIRED_BODY.schedule,
  durationCopy: null,
  canConfirm: true,
  restrictedReason: null,
};

/**
 * Answer the resolve the way the endpoint does — per REF, because the whole
 * point of Adjust is that the card starts resolving a different one.
 */
function mockResolveByRef(answers: Record<string, { state: unknown; view?: unknown }>) {
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const ref = JSON.parse(init?.body ?? "{}").ref as string;
    const answer = answers[ref] ?? { state: { state: "absent" }, view: null };
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderInChat() {
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <LifecycleCard view={PROPOSAL_VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("the expired proposal STAYS on screen", () => {
  it("draws the card instead of vanishing", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    const { container } = renderInChat();
    await waitFor(() =>
      expect(
        container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ).not.toBeNull(),
    );
  });

  it("says the proposal expired, in those words", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInChat();
    expect(await screen.findByText(/expired/i)).toBeTruthy();
  });

  it("says WHAT expired — the agent and the schedule the reader was shown", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInChat();
    expect(await screen.findByText(/Weekly digest/)).toBeTruthy();
    expect(screen.getByText(/Every weekday at 9:00 AM/)).toBeTruthy();
  });

  it("does NOT draw the shell's generic 'no longer open' line over it", async () => {
    // Same rung of the ladder, two different terminal readings — and only one
    // of them is true here. A proposal that timed out was never decided.
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInChat();
    await screen.findByText(/expired/i);
    expect(screen.queryByText("No longer open.")).toBeNull();
  });

  it("offers Adjust — a way out of a state the reader cannot act in", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInChat();
    expect(await screen.findByRole("button", { name: "Adjust" })).toBeTruthy();
  });

  it("is still there when the conversation is reopened", async () => {
    // A fresh mount is what a reload is. The card re-resolves the transcript's
    // own ref and gets the same expired reading, indefinitely.
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    const first = renderInChat();
    await screen.findByText(/expired/i);
    first.unmount();
    renderInChat();
    expect(await screen.findByText(/expired/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Adjust" })).toBeTruthy();
  });
});

describe("ADJUST re-proposes, in place", () => {
  it("mints a fresh proposal off the card's own ref and nothing else", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
      [FRESH_REF]: {
        state: { state: "pending", canDecide: true, canComment: false },
        view: PENDING_BODY,
      },
    });
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: true,
      token: FRESH_REF,
      expiresAt: 2_000_000_000,
    });
    renderInChat();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    // No agent id, no rows — the expired token carries both, server-side.
    expect(adjustExpiredScheduleProposal).toHaveBeenCalledWith({ token: EXPIRED_REF });
  });

  it("puts the fresh proposal in the card's place", async () => {
    const fetchMock = mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
      [FRESH_REF]: {
        state: { state: "pending", canDecide: true, canComment: false },
        view: PENDING_BODY,
      },
    });
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: true,
      token: FRESH_REF,
      expiresAt: 2_000_000_000,
    });
    const { container } = renderInChat();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    // The card re-resolves under the NEW ref and comes back to life: the
    // expired reading is gone and a live proposal is in its place.
    await waitFor(() =>
      expect(
        container.querySelector('[data-lifecycle-card-state="pending"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText(/expired/i)).toBeNull();
    const asked = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as { body: string }).body).ref as string,
    );
    expect(asked).toContain(FRESH_REF);
  });

  it("shows the server's own refusal and leaves the card pressable", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: false,
      error: "That time has already passed. Ask for a new time and confirm the new card.",
    });
    renderInChat();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    expect(await screen.findByText(/That time has already passed/)).toBeTruthy();
    // Still expired, still on screen, still pressable — a refusal is not a
    // reason to drop the card.
    expect(screen.getByText(/expired/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Adjust" })).toBeTruthy();
  });

  it("says something neutral when the action itself fails to reach the server", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    adjustExpiredScheduleProposal.mockRejectedValue(new Error("offline"));
    renderInChat();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    expect(await screen.findByText(/Try again/)).toBeTruthy();
  });
});

describe("the reader who may not see the subject still sees nothing at all", () => {
  it("draws NO DOM for `absent`, body or no body", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "absent" }, view: null },
    });
    const { container } = renderInChat();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull();
  });

  it("draws no Adjust for a body this build cannot read, only the state's own line", async () => {
    // Forward-compat: a newer producer's body degrades to S1's floor rather
    // than to a blank card or an invented affordance.
    mockResolveByRef({
      [EXPIRED_REF]: {
        state: { state: "settled" },
        view: { phase: "something_later", version: 99 },
      },
    });
    renderInChat();
    expect(await screen.findByText("No longer open.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull();
  });
});
