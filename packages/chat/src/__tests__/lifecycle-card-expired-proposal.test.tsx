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
 *
 * The wire is the S9c RESOLVE ENVELOPE (`{ kind, state, body }`), not a bare
 * state: the runtime parses it at the protocol's one seam against the kind the
 * card asked for. Answering in any other shape here would be testing against a
 * wire the app no longer speaks.
 */
function mockResolveByRef(answers: Record<string, { state: unknown; view?: unknown }>) {
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const parsedRequest = JSON.parse(init?.body ?? "{}") as { ref: string; viewType: string };
    const answer = answers[parsedRequest.ref] ?? { state: { state: "absent" }, view: null };
    // `absent` carries no body, ever — the parse REFUSES one beside it, because
    // a body there is the one thing that could tell the denials apart.
    const body = answer.view ?? null;
    return new Response(
      JSON.stringify({ kind: parsedRequest.viewType, state: answer.state, body }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
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

/**
 * The BROKERED host — the site widget. It declares a credential and
 * `credentials: "omit"`, which is the only shape the provider accepts for a
 * non-cookie host, and which is load-bearing: the embed frame is same-origin to
 * the app, so a cookie would let an ambient session belonging to whoever else
 * uses this browser answer as the reader.
 */
function renderInWidget(view: typeof PROPOSAL_VIEW = PROPOSAL_VIEW) {
  return render(
    <LifecycleCardSurfaceProvider
      host="site_widget"
      auth={{ headers: () => ({ "X-Cinatra-Widget": "cwu_test" }), credentials: "omit" }}
      frame={{ assistant: "cit_test", instanceId: "instance_test" }}
    >
      <LifecycleCard view={view} />
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

  it("draws the card on the CHAT host with Adjust actually pressable", async () => {
    // The positive half of the surface gate below: on a cookie-session host the
    // control is live, and the host is readable off the card's own root.
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    const { container } = renderInChat();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    expect((adjust as HTMLButtonElement).disabled).toBe(false);
    expect(
      container
        .querySelector("[data-lifecycle-card]")
        ?.getAttribute("data-lifecycle-card-host"),
    ).toBe("chat_thread");
  });

  it("draws NOTHING for a body this build cannot read — never an invented affordance", async () => {
    // Forward-compat, under the S9c envelope contract: a body-carrying kind
    // whose body does not validate is REFUSED at the parse seam, so the card is
    // left exactly where it was before the first resolve landed — drawing no
    // DOM at all. That is main's rule and this reading consumes it rather than
    // softening it: "a half-drawn card is not a lesser card; it is a card
    // asserting a reading it does not have." What must never happen either way
    // is an Adjust offered over a body nobody could read.
    mockResolveByRef({
      [EXPIRED_REF]: {
        state: { state: "settled" },
        view: { phase: "something_later", version: 99 },
      },
    });
    const { container } = renderInChat();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull();
  });
});

describe("ADJUST is gated on the COOKIE-SESSION surface", () => {
  // The card draws on every DECLARED host — including the brokered site widget,
  // which mounts with `credentials: "omit"` because its embed frame is
  // same-origin to the app. `adjustExpiredScheduleProposal` is a SERVER ACTION
  // and proves its caller by the first-party session cookie and nothing else, so
  // firing it from there either 401s or, worse, answers as whoever else is
  // signed in on that browser. The reading still belongs on the widget; the
  // cookie-bound control does not.

  it("still draws the expired reading on the widget — the READING is not the problem", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    const { container } = renderInWidget();
    expect(await screen.findByText(/expired/i)).toBeTruthy();
    // Anchored on the card's own root, which is also what a capture cites.
    const card = container.querySelector("[data-lifecycle-card]");
    expect(card?.getAttribute("data-lifecycle-card")).toBe("trigger_schedule_proposal");
    expect(card?.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(card?.getAttribute("data-lifecycle-card-state")).toBe("settled");
  });

  it("draws Adjust DISABLED there, with the reason on screen", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInWidget();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    expect((adjust as HTMLButtonElement).disabled).toBe(true);
    expect(adjust.getAttribute("data-lifecycle-action-disabled")).toBe("no_cookie_session");
    expect(screen.getByText(/propose this again from the full app/i)).toBeTruthy();
  });

  it("issues NO cookie-bound call from the widget, even when the press is forced", async () => {
    // The disabled attribute is a RENDERING fact; this is the one that matters.
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInWidget();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    expect(adjustExpiredScheduleProposal).not.toHaveBeenCalled();
  });

  it("says nothing about the reason on a cookie surface — no stray note there", async () => {
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    renderInChat();
    await screen.findByRole("button", { name: "Adjust" });
    expect(screen.queryByText(/propose this again from the full app/i)).toBeNull();
  });

  it("draws Adjust disabled with NO provider-refused declaration either", async () => {
    // A non-cookie host declared WITHOUT a credential is refused by the provider,
    // which leaves no host at all — so there is no card, and therefore no
    // cookie-bound control. The fail-closed default is silence, not a live
    // button.
    mockResolveByRef({
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="site_widget">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull();
    expect(adjustExpiredScheduleProposal).not.toHaveBeenCalled();
  });
});

describe("the local re-proposal is SCOPED to the ref it was made from", () => {
  // Renderable views are keyed BY INDEX, so React reuses one `LifecycleCard`
  // instance when the transcript changes underneath it. A re-proposal held in
  // that instance must not survive into the next proposal, or the reader
  // presses Adjust on proposal B and re-proposes proposal A.

  const OTHER_REF = "a-different-proposal-ref";
  const OTHER_VIEW = { ...PROPOSAL_VIEW, ref: OTHER_REF };

  function answers() {
    return {
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
      [FRESH_REF]: {
        state: { state: "pending", canDecide: true, canComment: false },
        view: PENDING_BODY,
      },
      [OTHER_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    };
  }

  it("drops the adjusted ref when the card's own ref changes underneath it", async () => {
    const fetchMock = mockResolveByRef(answers());
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: true,
      token: FRESH_REF,
      expiresAt: 2_000_000_000,
    });
    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    // Re-propose: the instance is now holding FRESH_REF, showing a live card.
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );

    // The SAME instance is now handed a DIFFERENT proposal.
    fetchMock.mockClear();
    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={OTHER_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });

    // It must resolve the NEW ref, and it must never resolve the old
    // re-proposal again under it.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const asked = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as { body: string }).body).ref as string,
    );
    expect(asked).toContain(OTHER_REF);
    expect(asked).not.toContain(FRESH_REF);
    expect(asked).not.toContain(EXPIRED_REF);
  });

  it("shows the NEW proposal's reading, not the re-proposed one", async () => {
    mockResolveByRef(answers());
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: true,
      token: FRESH_REF,
      expiresAt: 2_000_000_000,
    });
    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );
    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={OTHER_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });
    // Back to an expired reading — the new proposal's own — rather than the
    // previous card's live re-proposal painted under a new identity.
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull(),
    );
    expect(await screen.findByText(/expired/i)).toBeTruthy();
  });

  it("re-proposes the NEW ref when Adjust is pressed after the change", async () => {
    mockResolveByRef(answers());
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: true,
      token: FRESH_REF,
      expiresAt: 2_000_000_000,
    });
    const { rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    const first = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(first);
    });
    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={OTHER_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });
    adjustExpiredScheduleProposal.mockClear();
    const second = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(second);
    });
    // The ref that travels is the one the card is SHOWING — never the previous
    // proposal the instance happened to have re-proposed.
    expect(adjustExpiredScheduleProposal).toHaveBeenCalledWith({ token: OTHER_REF });
  });
});

describe("an IN-FLIGHT re-proposal is bound to the ref it was issued under", () => {
  // The reset above covers the ref changing while the card SITS there. It does
  // not, on its own, cover the press that is still in flight when it changes:
  // Adjust awaits a dynamic import and then a server action, so proposal A's
  // replacement can land after the instance has been handed proposal B. Storing
  // whatever arrives would draw A's live schedule on B's card — a schedule B's
  // reader was never shown and could then confirm.

  const OTHER_REF = "a-different-proposal-ref";
  const OTHER_VIEW = { ...PROPOSAL_VIEW, ref: OTHER_REF };

  function answers() {
    return {
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
      [FRESH_REF]: {
        state: { state: "pending", canDecide: true, canComment: false },
        view: PENDING_BODY,
      },
      [OTHER_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    };
  }

  /** An Adjust whose answer is released by the TEST, not by the microtask queue. */
  function deferredAdjust() {
    let release: (value: unknown) => void = () => {};
    adjustExpiredScheduleProposal.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    return async (value: unknown) => {
      await act(async () => {
        release(value);
      });
    };
  }

  it("drops a completion that lands AFTER the card moved to another proposal", async () => {
    const fetchMock = mockResolveByRef(answers());
    const release = deferredAdjust();
    const { container, rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    // The press is issued under EXPIRED_REF and does not answer yet.
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    expect(adjustExpiredScheduleProposal).toHaveBeenCalledWith({ token: EXPIRED_REF });

    // The SAME instance is handed a DIFFERENT proposal while that press is in
    // flight, and settles on its own expired reading.
    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={OTHER_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull(),
    );
    fetchMock.mockClear();

    // Only NOW does the first proposal's replacement arrive.
    await release({ ok: true, token: FRESH_REF, expiresAt: 2_000_000_000 });

    // It changes nothing: this card still draws the proposal it is actually
    // showing, and the stale replacement is never resolved under it.
    expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull();
    expect(screen.getByText(/expired/i)).toBeTruthy();
    expect(container.querySelector('[data-lifecycle-card-state="pending"]')).toBeNull();
    const asked = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as { body: string }).body).ref as string,
    );
    expect(asked).not.toContain(FRESH_REF);
    expect(asked).not.toContain(EXPIRED_REF);

    // And the card still acts as itself: the next press carries ITS ref.
    adjustExpiredScheduleProposal.mockReset();
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: true,
      token: FRESH_REF,
      expiresAt: 2_000_000_000,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
    });
    expect(adjustExpiredScheduleProposal).toHaveBeenCalledWith({ token: OTHER_REF });
  });

  it("still swaps in a completion that lands under an UNCHANGED ref", async () => {
    // The positive control for the same binding: nothing moved underneath the
    // card, so a late answer is still this card's answer and takes effect.
    mockResolveByRef(answers());
    const release = deferredAdjust();
    const { container } = renderInChat();
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    expect(container.querySelector('[data-lifecycle-card-state="pending"]')).toBeNull();

    await release({ ok: true, token: FRESH_REF, expiresAt: 2_000_000_000 });

    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="pending"]')).not.toBeNull(),
    );
    expect(screen.queryByText(/expired/i)).toBeNull();
  });
});

describe("the REFUSAL and the BUSY state are bound to the ref they were made under", () => {
  // The completion carries its origin; these two did not, and they are on
  // screen for exactly the same reason and for longer. The instance is reused
  // by index, so a refusal about proposal A stayed painted under proposal B —
  // telling B's reader that the card in front of them had already been
  // adjusted, or that a press they never made was still in flight. Both are
  // states of a card, not of a component, so both state which card.

  const OTHER_REF = "a-different-proposal-ref";
  const OTHER_VIEW = { ...PROPOSAL_VIEW, ref: OTHER_REF };

  function answers() {
    return {
      [EXPIRED_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
      [FRESH_REF]: {
        state: { state: "pending", canDecide: true, canComment: false },
        view: PENDING_BODY,
      },
      [OTHER_REF]: { state: { state: "settled" }, view: EXPIRED_BODY },
    };
  }

  function deferredAdjust() {
    let release: (value: unknown) => void = () => {};
    adjustExpiredScheduleProposal.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    return async (value: unknown) => {
      await act(async () => {
        release(value);
      });
    };
  }

  it("drops a refusal when the card moves to another proposal", async () => {
    mockResolveByRef(answers());
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: false,
      error: "This card was already adjusted. Use the newest card for this schedule and confirm that one.",
    });
    const { rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    const adjust = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(adjust);
    });
    expect(await screen.findByText(/already adjusted/)).toBeTruthy();

    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={OTHER_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });
    // The new card is drawn, and it is not carrying the previous card's answer.
    expect(await screen.findByText(/expired/i)).toBeTruthy();
    expect(screen.queryByText(/already adjusted/)).toBeNull();
  });

  it("keeps a refusal that is still about the card on screen", async () => {
    // The positive control: nothing moved, so the refusal is this card's own
    // and stays exactly where the reader can read it.
    mockResolveByRef(answers());
    adjustExpiredScheduleProposal.mockResolvedValue({
      ok: false,
      error: "That time has already passed. Ask for a new time and confirm the new card.",
    });
    const { rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    const press = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(press);
    });
    expect(await screen.findByText(/already passed/)).toBeTruthy();
    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={PROPOSAL_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });
    expect(screen.getByText(/already passed/)).toBeTruthy();
  });

  it("does not draw the previous card's press as THIS card's busy state", async () => {
    mockResolveByRef(answers());
    const release = deferredAdjust();
    const { rerender } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={PROPOSAL_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    // The press is issued under EXPIRED_REF and does not answer.
    const press = await screen.findByRole("button", { name: "Adjust" });
    await act(async () => {
      fireEvent.click(press);
    });
    expect(screen.getByRole("button", { name: "Proposing…" })).toBeTruthy();

    // The instance is handed a DIFFERENT proposal while that press hangs.
    await act(async () => {
      rerender(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <LifecycleCard view={OTHER_VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
    });
    // Nobody has pressed Adjust on THIS card, so it is pressable, not busy.
    const button = await screen.findByRole("button", { name: "Adjust" });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    // The stale press finally answers, and still changes nothing here.
    await release({ ok: false, error: "This card was already adjusted." });
    expect(screen.getByRole("button", { name: "Adjust" })).toBeTruthy();
    expect(screen.queryByText(/already adjusted/)).toBeNull();
  });
});
