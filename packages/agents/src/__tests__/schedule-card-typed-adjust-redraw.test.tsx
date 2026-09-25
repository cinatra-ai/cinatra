// @vitest-environment jsdom
//
// A TYPED CHANGE RE-DRAWS THE BOUND CARD IN PLACE (cinatra#2853, the second fix
// leg; plan (A) §2.2 — "a typed change re-draws the bound card IN PLACE, never
// a second card; the stale Confirm gone").
//
// THE DEFECT THESE CASES PIN, in the words of the round that recorded it: the
// typed schedule adjust — "make it 8 in the morning on weekdays" at a live 09:00
// card — now routes through the bound-card grant to the decide road, and the
// decide road RE-PROPOSES. Adjust cannot edit a proposal, because a proposal ref
// IS the proposal: it mints a REPLACEMENT ref and leaves the old one
// addressable. The card the person is looking at is mounted on the old ref, so
// nothing on the page ever learned the new one — the card kept drawing 09:00
// with its own Confirm still pressable, and the 08:00 rows the person asked for
// existed only behind a ref no mounted card knew.
//
// The card's OWN Adjust button never had this problem: it makes the call itself
// and swaps its ref from the answer. What these cases prove is that the SAME
// swap now happens when the change arrives from the typed road — one card, the
// adjusted rows, one Confirm, and the superseded ref drawn nowhere.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import {
  LifecycleCardSettleProvider,
  LifecycleCardSurfaceProvider,
  LifecycleComposerFocusProvider,
  createComposerFocusStore,
  createLifecycleCardSettleBus,
} from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The ref the card is mounted on — the 09:00 proposal in the picture. */
const STALE_REF = "proposal-ref-0900";
/** The ref the typed adjust minted — the 08:00 proposal behind it. */
const REPLACEMENT_REF = "proposal-ref-0800";
/** A DIFFERENT proposal the wire hands the same mounted component later. */
const WIRE_REF = "proposal-ref-1000";

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: STALE_REF,
};

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: false };

function recurringAt(hour: number, weekdays: number[]): ProposedSchedule {
  return {
    kind: "recurring",
    timezone: "Europe/Berlin",
    selection: {
      frequency: "weekly",
      interval: 1,
      weekdays,
      dayOfMonth: 1,
      monthlyMode: "date",
      nthWeek: 1,
      monthlyWeekday: 1,
      quarterAnchor: "start",
      yearlyMonth: 1,
      hour,
      minute: 0,
    },
  };
}

function proposalBody(schedule: ProposedSchedule): TriggerScheduleProposalViewBody {
  return {
    phase: "proposal",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule,
    durationCopy: "45s–3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
  };
}

/** What the card sees when it asks about the ref it is CURRENTLY drawn from. The
 *  09:00 proposal and the 08:00 one that replaced it are two different refs and
 *  two different answers, exactly as they are on the server. */
const BY_REF: Record<string, TriggerScheduleProposalViewBody> = {
  [STALE_REF]: proposalBody(recurringAt(9, [1, 2, 3, 4, 5])),
  [REPLACEMENT_REF]: proposalBody(recurringAt(8, [1, 2, 3, 4, 5])),
  [WIRE_REF]: proposalBody(recurringAt(10, [1, 2, 3, 4, 5])),
};

function mockResolveByRef() {
  const asked: string[] = [];
  const fetchMock = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const ref = String(
      (JSON.parse(String(init?.body ?? "{}")) as { ref?: string }).ref ?? "",
    );
    asked.push(ref);
    const body = BY_REF[ref] ?? null;
    return new Response(
      JSON.stringify({
        kind: "trigger_schedule_proposal",
        state: body ? PENDING : { state: "absent" },
        body,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, asked };
}

function renderCard() {
  const bus = createLifecycleCardSettleBus();
  const store = createComposerFocusStore();
  const rendered = render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <LifecycleCardSettleProvider bus={bus}>
        <LifecycleComposerFocusProvider store={store}>
          <ScheduleProposalCard view={VIEW} />
        </LifecycleComposerFocusProvider>
      </LifecycleCardSettleProvider>
    </LifecycleCardSurfaceProvider>,
  );
  return { bus, store, ...rendered };
}

/** The hour the card's own rows are showing, read off the row the reader sees. */
const drawnHour = (container: HTMLElement): string | null =>
  container.querySelector('[data-field="recurring-hour"]')?.textContent?.trim() ?? null;

const confirms = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll("button")).filter(
    (b) => b.textContent?.trim() === "Confirm",
  );

describe("the typed adjust's replacement reaches the mounted card", () => {
  it("re-draws THE SAME card on the adjusted rows, with one Confirm and no second card", async () => {
    const { asked, fetchMock } = mockResolveByRef();
    const { bus, container } = renderCard();

    // The state the picture recorded before the send: the 09:00 card, its own
    // Confirm live.
    await waitFor(() => expect(drawnHour(container)).toBe("09"));
    expect(confirms(container)).toHaveLength(1);
    const callsBefore = fetchMock.mock.calls.length;

    // The typed change lands. The decide road re-proposed, and the server said
    // which ref this card is now drawn from.
    await act(async () => {
      bus.announceReplacement(STALE_REF, REPLACEMENT_REF);
    });

    // IN PLACE: the same one card, now holding the rows the person asked for.
    await waitFor(() => expect(drawnHour(container)).toBe("08"));
    expect(container.querySelectorAll("[data-lifecycle-card]")).toHaveLength(1);
    expect(
      container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]'),
    ).not.toBeNull();
    // ONE Confirm — the adjusted card's. The stale card's is gone because the
    // stale card is gone: it was never a second card, it was this one.
    expect(confirms(container)).toHaveLength(1);
    // Mon–Fri, still, and nothing else pressed.
    const pressed = Array.from(
      container.querySelectorAll('[data-field="recurring-weekday"][aria-pressed="true"]'),
    ).map((el) => el.getAttribute("data-weekday"));
    expect(pressed).toEqual(["1", "2", "3", "4", "5"]);
    // It asked the server about the REPLACEMENT, under the reader's own access —
    // the card never draws an announcement's word for the answer.
    expect(asked).toContain(REPLACEMENT_REF);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("moves the composer binding to the replacement, so a SECOND message reaches the card in front of the reader", async () => {
    mockResolveByRef();
    const { bus, store, container } = renderCard();

    await waitFor(() => expect(store.getSnapshot().eligible).toEqual([STALE_REF]));

    await act(async () => {
      bus.announceReplacement(STALE_REF, REPLACEMENT_REF);
    });

    await waitFor(() => expect(drawnHour(container)).toBe("08"));
    // The superseded ref is no longer claimable at all: a message typed now
    // cannot mint a grant against the proposal the person already changed.
    expect(store.getSnapshot().eligible).toEqual([REPLACEMENT_REF]);
  });

  it("leaves a card the announcement does not name exactly where it was", async () => {
    mockResolveByRef();
    const { bus, container } = renderCard();

    await waitFor(() => expect(drawnHour(container)).toBe("09"));
    await act(async () => {
      bus.announceReplacement("proposal-ref-somebody-elses", REPLACEMENT_REF);
    });

    expect(drawnHour(container)).toBe("09");
    expect(confirms(container)).toHaveLength(1);
  });

  it("follows a CHAIN of adjusts to the last one, in one card", async () => {
    // Two typed changes in one page session: 09:00 → 08:00 → 07:00. The card
    // walks itself forward rather than stopping at the first replacement.
    const THIRD = "proposal-ref-0700";
    BY_REF[THIRD] = proposalBody(recurringAt(7, [1, 2, 3, 4, 5]));
    mockResolveByRef();
    const { bus, container } = renderCard();

    await waitFor(() => expect(drawnHour(container)).toBe("09"));
    await act(async () => {
      bus.announceReplacement(STALE_REF, REPLACEMENT_REF);
      bus.announceReplacement(REPLACEMENT_REF, THIRD);
    });

    await waitFor(() => expect(drawnHour(container)).toBe("07"));
    expect(container.querySelectorAll("[data-lifecycle-card]")).toHaveLength(1);
    expect(confirms(container)).toHaveLength(1);
    delete BY_REF[THIRD];
  });
});

describe("the announcement is an address, and only an address", () => {
  it("refuses a ref replaced by ITSELF — a card can never be told to follow itself", () => {
    const bus = createLifecycleCardSettleBus();
    bus.announceReplacement(STALE_REF, STALE_REF);
    expect(bus.replacementFor(STALE_REF)).toBeNull();
  });

  it("refuses an empty address on either side", () => {
    const bus = createLifecycleCardSettleBus();
    bus.announceReplacement("", REPLACEMENT_REF);
    bus.announceReplacement(STALE_REF, "");
    expect(bus.replacementFor("")).toBeNull();
    expect(bus.replacementFor(STALE_REF)).toBeNull();
  });

  it("keeps the FIRST word about a ref — a replayed announcement moves nothing", () => {
    // The turn driver replays a completed tool result on a durable-log resume,
    // and a later message can announce about a ref no card is drawn from any
    // more. Neither may move a card that has already moved on.
    const bus = createLifecycleCardSettleBus();
    bus.announceReplacement(STALE_REF, REPLACEMENT_REF);
    bus.announceReplacement(STALE_REF, "proposal-ref-late");
    expect(bus.replacementFor(STALE_REF)).toBe(REPLACEMENT_REF);
  });

  it("refuses an announcement that would CLOSE a chain — a card can never re-point forever", () => {
    // A card follows this map during its own render, so a→b→a would re-point it
    // on every render instead of settling. Nothing legitimate builds one — every
    // re-proposal mints a token that has never existed — and the map refuses it
    // rather than relying on that.
    const bus = createLifecycleCardSettleBus();
    bus.announceReplacement("a", "b");
    bus.announceReplacement("b", "c");
    bus.announceReplacement("c", "a");
    expect(bus.replacementFor("c")).toBeNull();
    expect(bus.replacementFor("a")).toBe("b");
    expect(bus.replacementFor("b")).toBe("c");
  });

  it("says nothing about a ref nobody announced", () => {
    const bus = createLifecycleCardSettleBus();
    expect(bus.replacementFor(REPLACEMENT_REF)).toBeNull();
  });
});

describe("a wire-ref change is about the proposal the WIRE names", () => {
  it("does not let a replacement announced for the PREVIOUS ref land on top of a new wire ref", async () => {
    const { asked } = mockResolveByRef();
    const bus = createLifecycleCardSettleBus();
    const store = createComposerFocusStore();
    const draw = (ref: string) => (
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSettleProvider bus={bus}>
          <LifecycleComposerFocusProvider store={store}>
            <ScheduleProposalCard
              view={{ viewType: "trigger_schedule_proposal", schemaVersion: 1, ref }}
            />
          </LifecycleComposerFocusProvider>
        </LifecycleCardSettleProvider>
      </LifecycleCardSurfaceProvider>
    );
    const { container, rerender } = render(draw(STALE_REF));
    await waitFor(() => expect(drawnHour(container)).toBe("09"));

    // THE RACE. The announcement about the ref this instance is drawn from and
    // the wire handing the same instance a DIFFERENT proposal arrive together.
    // The wire is the turn's own word about what this slot holds, so it wins:
    // a card that ends up on the replacement here would draw — and decide about
    // — a proposal the turn has already moved off.
    await act(async () => {
      bus.announceReplacement(STALE_REF, REPLACEMENT_REF);
      rerender(draw(WIRE_REF));
    });

    await waitFor(() => expect(drawnHour(container)).toBe("10"));
    expect(container.querySelectorAll("[data-lifecycle-card]")).toHaveLength(1);
    expect(confirms(container)).toHaveLength(1);
    expect(store.getSnapshot().eligible).toEqual([WIRE_REF]);
    // It never went to the superseded family's replacement at all.
    expect(asked).not.toContain(REPLACEMENT_REF);
  });
});
