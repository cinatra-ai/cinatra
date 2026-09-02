// @vitest-environment jsdom
//
// `ScheduleProposalCard` — the ONE schedule renderer (cinatra#2788, epic #2784
// S9d). Design: design@92c1be7c6f864dec6382a9ef01e7b2e1c38aa871
// `specs/app-lifecycle-cards.html` §VI, §IX. Plan: §7, §2.
//
// What is pinned here is what a later slice must not be able to weaken by
// accident: every body phase draws its mandated shape, the two ABSENCES stay
// two, the decision travels on the HOST's own credential (and the widget's
// never on a cookie), the settled controls reach the canonical operations, and
// exactly ONE card root is rendered per kind × host.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  LIFECYCLE_VIEW_DECIDE_PATH,
  ScheduleProposalCard,
  adjustAndConfirmSchedule,
  submitScheduleDecision,
} from "../schedule-proposal-card";
import { SAVE_SCHEDULE_REFUSALS } from "../trigger-recurrence";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "proposal-ref-abc",
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
    durationCopy: "About 45s – 3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
    ...over,
  };
}

function settledBody(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Weekly cohort sweep",
    runId: "run-777",
    // The ARMED selections — the settled card draws the same rows (plan §7.2).
    schedule: RECURRING,
    triggerType: "recurring",
    scheduleCopy: "Every weekday at 9:00 AM",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    // cinatra#2972 — the default fixture is a RECURRING schedule that has fired
    // once, which is the one state plan (A) §7.2 puts **Cancel schedule** in.
    canCancel: true,
    ...over,
  };
}

const EXPIRED_BODY: TriggerScheduleProposalViewBody = {
  phase: "expired",
  version: 1,
  agentName: "Weekly cohort sweep",
  schedule: RECURRING,
  scheduleCopy: "Every weekday at 9:00 AM",
};

/**
 * The resolve answer, in the per-kind envelope the card parses (S9c). Every
 * decision POST answers with the outcome shape the endpoint returns, so one
 * mock serves both directions and the test can read what was actually sent.
 */
function mockTransport(
  state: LifecycleCardState,
  body: TriggerScheduleProposalViewBody | null,
  outcome: unknown = { kind: "confirmed", runId: "run-777", alreadyConfirmed: false },
) {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision =
      typeof init?.body === "string" && init.body.includes('"op"');
    return new Response(
      JSON.stringify(
        isDecision
          ? { outcome }
          : { kind: "trigger_schedule_proposal", state, body },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The widget's credential declaration — the real shape the embed passes, and
 *  the one the provider's fail-closed invariant requires of a non-cookie host. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

type Host = "chat_thread" | "run_card" | "page_gate_region" | "site_widget";

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

function isDisabled(el: Element | null): boolean {
  return (el as HTMLButtonElement | null)?.disabled === true;
}

/** Every decision body this mock was sent, in order. */
function decisionBodies(
  fetchMock: ReturnType<typeof mockTransport>,
): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter((b): b is string => typeof b === "string" && b.includes('"op"'))
    .map((b) => JSON.parse(b) as Record<string, unknown>);
}

/** The last decision body this mock was sent. */
function lastDecision(fetchMock: ReturnType<typeof mockTransport>): Record<string, unknown> {
  const bodies = decisionBodies(fetchMock);
  return bodies[bodies.length - 1] ?? {};
}

/** The decision request's own init, for reading credentials and headers. */
function decisionInit(fetchMock: ReturnType<typeof mockTransport>): {
  url: unknown;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls.find(
    ([, init]) =>
      typeof (init as RequestInit | undefined)?.body === "string" &&
      String((init as RequestInit).body).includes('"op"'),
  );
  if (!call) throw new Error("no decision request was made");
  return { url: call[0], init: call[1] as RequestInit };
}

// ---------------------------------------------------------------------------
// §VI — the three body phases
// ---------------------------------------------------------------------------

describe("§VI the schedule proposal card", () => {
  it("proposal: the option rows EDITABLE as they stand, the chosen row marked, the duration, and a Confirm-only floor", async () => {
    mockTransport({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { container } = renderOn("chat_thread");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull(),
    );
    // All three rows are drawn; the proposed one takes the edge and the tint.
    expect(container.querySelectorAll("[data-schedule-option]")).toHaveLength(3);
    expect(
      container.querySelector('[data-schedule-option="recurring"]')?.getAttribute("data-chosen"),
    ).toBe("true");
    expect(
      container.querySelector('[data-schedule-option="immediate"]')?.getAttribute("data-chosen"),
    ).toBe("false");
    // The chosen row OWNS its fields — the others draw none at all.
    expect(container.querySelector('[data-field="recurring-hour"]')).not.toBeNull();
    expect(container.querySelector('[data-field="schedule-run-at"]')).toBeNull();
    // §VI's estimated duration line, and its floor.
    expect(
      container.querySelector('[data-conformance-id="schedule-duration"]')?.textContent,
    ).toContain("About 45s");
    expect(container.querySelector('[data-conformance-id="schedule-proposal-floor"]')).not.toBeNull();
    expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull();
    // …AND NOTHING ELSE. Plan (A) §7.2: "The floor is **Confirm**."
    expect(container.querySelector('[data-action="adjust-schedule-proposal"]')).toBeNull();
    // The rows are live on first paint, with no step to open them.
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(false);
    // NO RAW CRON FIELD, anywhere in the drawn card.
    expect(container.innerHTML).not.toMatch(/cron/i);
    // Nothing exists yet — the settled chrome is not drawn beside the proposal.
    expect(container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).toBeNull();
  });

  it("restricted: the card is DRAWN with a dead Confirm and the reason on screen — never dropped", async () => {
    mockTransport(
      {
        state: "restricted",
        canDecide: false,
        canComment: false,
        reason: "You can't run this agent right now.",
      },
      proposalBody({ canConfirm: false, restrictedReason: "You can't run this agent right now." }),
    );
    const { container } = renderOn("chat_thread");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-action="confirm-schedule-proposal"]'))).toBe(true);
    expect(
      container.querySelector('[data-conformance-id="schedule-proposal-restricted-reason"]')
        ?.textContent,
    ).toContain("You can't run this agent right now.");
    expect(container.querySelector('[data-lifecycle-card-state="restricted"]')).not.toBeNull();
  });

  // PLAN §7.2 step 5 and §7.2, on the PAGE host. The page's schedule step is the
  // FORM and its controls — plan (A) §7.2, amended 2026-08-23: "The schedule
  // step on the run page and the review page shows the same form and nothing
  // else — no summary box, no status label". The step is still where you "see
  // the configuration or change it", so the rows stay editable.
  it("settled on a PAGE host: the form only — no chrome, the SAME editable rows, Save changes, and the ONE control", async () => {
    mockTransport({ state: "settled" }, settledBody());
    const { container } = renderOn("run_card");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).toBeNull();
    expect(container.textContent).not.toContain("Trigger configuration");
    expect(container.textContent).not.toContain("Steps held until trigger fires");
    expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull();
    // cinatra#2972 — "there is no Run now" (plan (A) §7.2, amended 2026-08-25).
    expect(container.querySelector('[data-action="release-trigger-now"]')).toBeNull();
    expect(container.textContent).not.toContain("Run now");
    // The SAME option rows the proposal drew, showing the armed schedule and
    // open to change — one set of them, not two.
    expect(container.querySelectorAll('[data-conformance-id="schedule-option-rows"]')).toHaveLength(1);
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(false);
    expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull();
    // …and no Confirm: this schedule is armed, not proposed.
    expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).toBeNull();
  });

  // PLAN §7.2, and the whole of it: after Confirm the conversation shows the SAME
  // card, the SAME rows and a Save-changes control — and NEITHER of the
  // trigger's own control. Plan (A) §7.2 as amended 2026-08-25: **Cancel
  // schedule** "is on the run page's schedule step; there is no Run now."
  it("settled in a CONVERSATION: the same rows and Save changes, and NO trigger chrome or Cancel", async () => {
    for (const host of ["chat_thread", "site_widget"] as const) {
      mockTransport({ state: "settled" }, settledBody());
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      // The armed schedule, in the same rows.
      expect(
        view.container.querySelector('[data-schedule-option="recurring"]')?.getAttribute("data-chosen"),
      ).toBe("true");
      expect(view.container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull();
      // The trigger's chrome is NOT here.
      expect(view.container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).toBeNull();
      expect(view.container.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
      expect(view.container.querySelector('[data-action="release-trigger-now"]')).toBeNull();
      expect(view.container.textContent).not.toContain("Cancel trigger");
      expect(view.container.textContent).not.toContain("Release now");
      view.unmount();
      cleanup();
    }
  });

  // PLAN §7.4 as-designed step 4 — the identity clause: the card the reader confirmed is the card the
  // reader is left with — one root, same kind, same host, phase moved.
  it("the chat card KEEPS ITS IDENTITY across Confirm — one root before and after, never a second card", async () => {
    let settled = false;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw.includes('"op"')) {
        settled = true;
        return new Response(
          JSON.stringify({ outcome: { kind: "confirmed", runId: "run-777", alreadyConfirmed: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(
          settled
            ? { kind: "trigger_schedule_proposal", state: { state: "settled" }, body: settledBody() }
            : {
                kind: "trigger_schedule_proposal",
                state: { state: "pending", canDecide: true, canComment: false },
                body: proposalBody(),
              },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-phase="proposal"]')).not.toBeNull(),
    );
    const before = container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
    expect(container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]')).toHaveLength(1);

    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-phase="settled"]')).not.toBeNull(),
    );
    // ONE card, and it is the SAME DOM node — not a second card drawn beside it
    // and not a replacement mounted in its place.
    expect(container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]')).toHaveLength(1);
    expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).toBe(before);
    expect(before?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull();
  });

  // PLAN §7.2's Save changes, end to end through the card's own transport.
  it("Save changes posts the EDITED rows as `save` on the card's own ref, and re-resolves rather than drawing optimistically", async () => {
    const decisions: Record<string, unknown>[] = [];
    let resolves = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw.includes('"op"')) {
        decisions.push(JSON.parse(raw) as Record<string, unknown>);
        return new Response(JSON.stringify({ outcome: { kind: "saved", runId: "run-777" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      resolves += 1;
      return new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body: settledBody(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    // Nothing edited yet — there is nothing to save.
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(true);
    const resolvesBefore = resolves;

    fireEvent.change(container.querySelector('[data-field="recurring-timezone"]')!, {
      target: { value: "Europe/Lisbon" },
    });
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(false);
    fireEvent.click(container.querySelector('[data-action="save-schedule-changes"]')!);

    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0].op).toBe("save");
    expect(decisions[0].ref).toBe(VIEW.ref);
    expect((decisions[0].schedule as { timezone: string }).timezone).toBe("Europe/Lisbon");
    // No cron travels — the selections do (§VI).
    expect(JSON.stringify(decisions[0])).not.toMatch(/cron/i);
    // A landed save RE-RESOLVES: the server is what says what is armed now.
    await waitFor(() => expect(resolves).toBeGreaterThan(resolvesBefore));
  });

  it("Save changes is withheld where the server will refuse it — canSave false draws a dead control", async () => {
    mockTransport({ state: "settled" }, settledBody({ canSave: false }));
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(true);
    // The rows are read-only too — an offer to edit what cannot be saved is a
    // control that fails on press, which §IV rules out.
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(true);
  });

  // WAS: "Run now is admin-only — a non-admin body draws no control at all".
  // cinatra#2972 withdrew the control from every reader, admin included, so the
  // statement is now unconditional (plan (A) §7.2 amended 2026-08-25: "there is
  // no Run now").
  it("settled: NO reader gets a Run now — the control is gone from every host", async () => {
    for (const host of [
      "chat_thread",
      "site_widget",
      "run_card",
      "page_gate_region",
    ] as const) {
      mockTransport({ state: "settled" }, settledBody());
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      expect(view.container.querySelector('[data-action="release-trigger-now"]'), host).toBeNull();
      expect(view.container.textContent, host).not.toContain("Run now");
      view.unmount();
      cleanup();
    }
  });

  // cinatra#2972 CHANGED THE SHAPE OF A WITHHELD CANCEL. It used to be drawn
  // disabled; the plan now defines the control as "shown only for a recurring
  // schedule that has fired once", so wherever the plan does not put it the
  // control is ABSENT, not dead. The arming LINE is unchanged — the reader is
  // still owed the reason.
  it("settled: ARMING withholds Cancel and says why, rather than drawing a control at all", async () => {
    mockTransport(
      { state: "settled" },
      settledBody({ arming: true, canCancel: false }),
    );
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-arming"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
  });

  it("the CHOSEN weekdays are drawn on the legible variant, on both grounds", async () => {
    // Caught by looking at a dark capture, not by review: the outline variant
    // carries its own `dark:bg-input/30`, which survives beside an unprefixed
    // `bg-primary` and painted over the selection — every weekday chip rendered
    // identically muted in the dark theme, so the reader could not see WHICH
    // days the card was proposing. A selected day is the `default` variant (the
    // one Confirm draws with) and keeps its fill while the rows are read-only.
    mockTransport({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="recurring-weekday"]')).not.toBeNull(),
    );
    const chips = [...container.querySelectorAll('[data-field="recurring-weekday"]')];
    expect(chips).toHaveLength(7);
    for (const chip of chips) {
      const chosen = chip.getAttribute("aria-pressed") === "true";
      expect(chip.getAttribute("data-variant")).toBe(chosen ? "default" : "outline");
      // The read-only rows must not wash the selection out.
      if (chosen) expect(chip.getAttribute("class") ?? "").toContain("disabled:opacity-100");
    }
    // Monday to Friday, exactly the schedule the body proposed.
    expect(chips.filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.getAttribute("data-weekday")))
      .toEqual(["1", "2", "3", "4", "5"]);
  });

  // PLAN §7.2 step 2, on the expired face. Plan (A) §7.2 step 2: "an expired proposal
  // **stays visible**, still editable, with **Confirm** to propose again."
  it("expired: the card STAYS VISIBLE, its rows editable, on the SAME Confirm floor — and no Adjust anywhere", async () => {
    mockTransport({ state: "settled" }, EXPIRED_BODY);
    const { container } = renderOn("chat_thread");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-proposal-expired"]')).not.toBeNull(),
    );
    // The rows the reader last saw, editable — not a blank form and not a locked one.
    expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull();
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(false);
    // The floor is Confirm, exactly as it is on a live proposal.
    expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull();
    expect(container.querySelector('[data-action="adjust-schedule-proposal"]')).toBeNull();
    expect(container.querySelector('[data-lifecycle-card-phase="expired"]')).not.toBeNull();
  });

  // THE CARD SHOWS THE SCHEDULE THE READER STATED — never "the assistant's
  // proposal". A schedule a person stated in the conversation is their
  // instruction; the card reads it back and Confirm arms it. Plan (A) §7.2.
  it("expired: the copy names THE SCHEDULE the reader stated, never a proposal", async () => {
    mockTransport({ state: "settled" }, EXPIRED_BODY);
    const { container } = renderOn("chat_thread");

    const expired = await waitFor(() => {
      const node = container.querySelector('[data-conformance-id="schedule-proposal-expired"]');
      expect(node).not.toBeNull();
      return node as Element;
    });
    const copy = (expired.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(copy).toBe(
      "This schedule expired before it was confirmed. Nothing was scheduled — change it if you like, then confirm it again.",
    );
    expect(copy.toLowerCase()).not.toContain("proposal");
    expect(copy.toLowerCase()).not.toContain("propose");
  });

  // PLAN §7.2, stated as an absence over the WHOLE card, on every host and every
  // phase: there is no Adjust control anywhere any more.
  it("NO Adjust control exists on any phase or any host — the rows are the only way to change a proposal", async () => {
    for (const host of ["chat_thread", "site_widget", "run_card", "page_gate_region"] as const) {
      for (const [state, body] of [
        [{ state: "pending", canDecide: true, canComment: false } as LifecycleCardState, proposalBody()],
        [{ state: "settled" } as LifecycleCardState, settledBody()],
        [{ state: "settled" } as LifecycleCardState, EXPIRED_BODY],
      ] as const) {
        mockTransport(state, body);
        const view = renderOn(host);
        await waitFor(() =>
          expect(
            view.container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]'),
          ).not.toBeNull(),
        );
        expect(view.container.querySelector('[data-action="adjust-schedule-proposal"]')).toBeNull();
        expect(view.container.textContent).not.toContain("Adjust");
        view.unmount();
        cleanup();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The two ABSENCES, held apart
// ---------------------------------------------------------------------------

describe("the two absences", () => {
  it("absent: a reader who may not see the proposal gets NO card DOM at all", async () => {
    const fetchMock = mockTransport({ state: "absent" }, null);
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector("[data-lifecycle-card]")).toBeNull(),
    );
  });

  it("no host: a subtree that declared none draws nothing AND issues no resolve", async () => {
    const fetchMock = mockTransport({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { container } = render(<ScheduleProposalCard view={VIEW} />);
    expect(container.querySelector("[data-lifecycle-card]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("advisory is not a schedule state — the card fails closed rather than draw a floor over nothing", async () => {
    const fetchMock = mockTransport({ state: "advisory" }, null);
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("[data-lifecycle-card]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §IX — the same card on all four hosts, and exactly ONE instance on each
// ---------------------------------------------------------------------------

describe("§IX every host draws the same card", () => {
  // ONE test for the WHOLE ratified anchor set, deliberately. The contract table
  // S9a shipped (scripts/audit/chat-hitl-one-card-gate.mjs) reads a kind's closed
  // anchor set off a SINGLE named rendered proof, so a card cannot borrow half of
  // its evidence from a neighbouring case. §VI's set spans two phases — the
  // proposal's rows and floor, the settled trigger's chrome and its two quiet
  // controls — so both are driven here, on every host, in one case.
  it("the root carries its lifecycle-card identity, its host and its state — one instance per host, drawing the ratified anchor set", async () => {
    // The hosts are named as literals, one per line, because this test IS the
    // record of which hosts were actually driven.
    for (const host of [
      "chat_thread",
      "site_widget",
      "run_card",
      "page_gate_region",
    ] as const) {
      mockTransport({ state: "pending", canDecide: true, canComment: false }, proposalBody());
      const pending = renderOn(host);
      await waitFor(() =>
        expect(
          pending.container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]'),
        ).not.toBeNull(),
      );
      // The runtime property the epic states: ONE rendered instance per kind × host.
      expect(
        pending.container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ).toHaveLength(1);
      const root = pending.container.querySelector(
        '[data-lifecycle-card="trigger_schedule_proposal"]',
      );
      expect(root?.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(root?.getAttribute("data-lifecycle-card-state")).toBe("pending");
      expect(root?.getAttribute("data-conformance-id")).toBe("schedule-proposal-card");
      // The proposal half of the ratified anchor set, off real DOM on every host.
      expect(
        pending.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
      ).not.toBeNull();
      expect(
        pending.container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
      ).not.toBeNull();
      pending.unmount();
      cleanup();

      // The SETTLED half of the same set, on the same host: the Save-changes
      // floor everywhere, plus — on the two PAGE hosts, where this card IS the
      // schedule step — the two operations. The chrome anchor is GONE from the
      // set on every host (plan (A) §7.2: the step "shows the same form and
      // nothing else"), and the conversation is ruled not to have the two
      // operations either, so they are read on the hosts that draw them.
      const pageHost = host === "run_card" || host === "page_gate_region";
      mockTransport({ state: "settled" }, settledBody());
      const settled = renderOn(host);
      await waitFor(() =>
        expect(
          settled.container.querySelector('[data-action="save-schedule-changes"]'),
        ).not.toBeNull(),
      );
      expect(
        settled.container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ).toHaveLength(1);
      const settledRoot = settled.container.querySelector(
        '[data-lifecycle-card="trigger_schedule_proposal"]',
      );
      expect(settledRoot?.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(settledRoot?.getAttribute("data-lifecycle-card-state")).toBe("settled");
      // The armed card keeps the SAME option rows (requirement 3).
      expect(
        settled.container.querySelectorAll('[data-conformance-id="schedule-option-rows"]'),
      ).toHaveLength(1);
      expect(
        settled.container.querySelectorAll('[data-conformance-id="schedule-proposal-floor"]'),
      ).toHaveLength(1);
      expect(
        settled.container.querySelectorAll('[data-conformance-id="scheduled-run-chrome"]'),
      ).toHaveLength(0);
      expect(
        settled.container.querySelectorAll('[data-action="cancel-trigger-schedule"]'),
      ).toHaveLength(pageHost ? 1 : 0);
      // cinatra#2972 — the anchor set lost one member: "there is no Run now"
      // (plan (A) §7.2, amended 2026-08-25). Zero on EVERY host, page hosts
      // included, which is the only reading the plan leaves.
      expect(
        settled.container.querySelectorAll('[data-action="release-trigger-now"]'),
      ).toHaveLength(0);
      settled.unmount();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The DECISION travels on the HOST's own credential (S8b's shape)
// ---------------------------------------------------------------------------

describe("credential-aware decisions", () => {
  it("a first-party host confirms same-origin, with no broker header", async () => {
    const fetchMock = mockTransport(
      { state: "pending", canDecide: true, canComment: false },
      proposalBody(),
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

    await waitFor(() => expect(lastDecision(fetchMock).op).toBe("confirm"));
    const { url, init } = decisionInit(fetchMock);
    expect(url).toBe(LIFECYCLE_VIEW_DECIDE_PATH);
    expect(init.credentials).toBe("same-origin");
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain(
      "X-Cinatra-Widget-User-Token",
    );
    const body = JSON.parse(String(init.body));
    expect(body.kind).toBe("trigger_schedule_proposal");
    expect(body.ref).toBe(VIEW.ref);
    // The client names no run and no template.
    expect(body.runId).toBeUndefined();
    expect(body.templateId).toBeUndefined();
  });

  it("the WIDGET confirms on the broker headers, at credentials: omit — never on an ambient cookie", async () => {
    const fetchMock = mockTransport(
      { state: "pending", canDecide: true, canComment: false },
      proposalBody(),
    );
    const { container } = renderOn("site_widget");
    await waitFor(() =>
      expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

    await waitFor(() => expect(lastDecision(fetchMock).op).toBe("confirm"));
    const { init } = decisionInit(fetchMock);
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"]).toBe("cwu_user");
  });

  // The card once carried a deep link into the armed run, gated on a real
  // cookie session. The maintainer removed it from the card altogether
  // (PR #2939), so there is no cookie-bound affordance left to gate: the
  // absence is now unconditional, and that is what this reads.
  it("NO cookie-bound affordance on any host: the deep link into the run is gone from the card", async () => {
    for (const host of ["site_widget", "chat_thread", "run_card", "page_gate_region"] as const) {
      mockTransport({ state: "settled" }, settledBody());
      const view = renderOn(host);
      await waitFor(() =>
        expect(view.container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
      );
      expect(view.container.querySelector('[data-conformance-id="schedule-open-run"]')).toBeNull();
      expect(view.container.textContent).not.toContain("Open the run");
      view.unmount();
      cleanup();
    }
  });

  it("Cancel schedule asks first, in the schedule's own words, and only then acts", async () => {
    const fetchMock = mockTransport({ state: "settled" }, settledBody(), { kind: "cancelled" });
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="cancel-trigger-schedule"]')!);
    // Asked, not done.
    const strip = container.querySelector('[data-conformance-id="schedule-cancel-confirm"]');
    expect(strip).not.toBeNull();
    // cinatra#2972 rewrote these words with the act: Cancel schedule STOPS a
    // recurring schedule; it "never deletes the schedule or pauses the run".
    expect(strip?.textContent).toContain("Stop this recurring schedule?");
    expect(strip?.textContent).not.toContain("paused");
    expect(decisionBodies(fetchMock)).toHaveLength(0);

    fireEvent.click(strip!.querySelector('[data-action="confirm-destructive"]')!);
    await waitFor(() => expect(lastDecision(fetchMock).op).toBe("cancel"));
  });

  // WAS: "Run now asks first with its irreversibility warning, then reaches the
  // release operation". The control, its warning and its `release` op are all
  // withdrawn (cinatra#2972). What replaces the pin is the op-level statement in
  // "the decision surface carries no `release` op" below, so the property is
  // asserted rather than deleted.

  it("a refused decision is said on the card, and nothing is drawn optimistically", async () => {
    const fetchMock = mockTransport(
      { state: "pending", canDecide: true, canComment: false },
      proposalBody(),
      { kind: "not-permitted", message: "You can't take this action on this schedule." },
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="schedule-proposal-refusal"]')?.textContent,
      ).toContain("You can't take this action"),
    );
    // Still the proposal — the card did not settle itself.
    expect(container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PLAN §7.2 (2) — the rows are editable as they stand, and Confirm is the only floor
// ---------------------------------------------------------------------------

describe("the rows are editable as they stand — no Adjust step", () => {
  it("the rows are LIVE on first paint, with no control to unlock them", async () => {
    mockTransport({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="recurring-timezone"]')).not.toBeNull(),
    );
    // Plan (A) §7.2: "The option rows are editable as they stand … the rows are
    // never locked behind a separate step."
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(false);
    expect(isDisabled(container.querySelector('[data-field="recurring-weekday"]'))).toBe(false);
    expect(container.querySelector('[data-action="adjust-schedule-proposal"]')).toBeNull();
    // ONE set of rows, and the floor holds exactly one control.
    expect(container.querySelectorAll('[data-conformance-id="schedule-option-rows"]')).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-conformance-id="schedule-proposal-floor"] [data-action]'),
    ).toHaveLength(1);
  });

  it("a RESTRICTED reader gets read-only rows, because editing what they cannot confirm is a dead offer", async () => {
    mockTransport(
      { state: "restricted", canDecide: false, canComment: false, reason: "You can't dispatch this agent." },
      proposalBody({ canConfirm: false, restrictedReason: "You can't dispatch this agent." }),
    );
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="recurring-timezone"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(true);
    expect(isDisabled(container.querySelector('[data-action="confirm-schedule-proposal"]'))).toBe(true);
  });

  it("an EDITED proposal is re-proposed and THEN confirmed, on the new ref", async () => {
    const decisions: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw.includes('"op"')) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        decisions.push(body);
        return new Response(
          JSON.stringify({
            outcome:
              body.op === "adjust"
                ? { kind: "reproposed", ref: "proposal-ref-NEW", expiresAt: 1 }
                : { kind: "confirmed", runId: "run-777", alreadyConfirmed: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: { state: "pending", canDecide: true, canComment: false },
          body: proposalBody(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="recurring-timezone"]')).not.toBeNull(),
    );
    // The reader corrects the row in place — no Adjust to press first. (The
    // timezone field is driven here
    // rather than the hour select because the shipped Select is a Radix listbox
    // that jsdom cannot open; the ADJUST-then-CONFIRM order this test exists to
    // pin is the same whichever field changed.)
    fireEvent.change(container.querySelector('[data-field="recurring-timezone"]')!, {
      target: { value: "Europe/Lisbon" },
    });
    fireEvent.click(container.querySelector('[data-action="confirm-schedule-proposal"]')!);

    await waitFor(() => expect(decisions).toHaveLength(2));
    // ADJUST FIRST, carrying the corrected selections and no cron field.
    expect(decisions[0].op).toBe("adjust");
    expect(decisions[0].ref).toBe(VIEW.ref);
    expect((decisions[0].schedule as { timezone: string }).timezone).toBe("Europe/Lisbon");
    expect(JSON.stringify(decisions[0])).not.toMatch(/cron/i);
    // THEN confirm — on the NEW ref, never the one the reader just corrected.
    expect(decisions[1].op).toBe("confirm");
    expect(decisions[1].ref).toBe("proposal-ref-NEW");
  });
});

// ---------------------------------------------------------------------------
// The #2853 SEAM — the prompt window acts through the card's own action surface
// ---------------------------------------------------------------------------

describe("the prompt-window action seam (cinatra#2853)", () => {
  it("adjustAndConfirmSchedule is adjust-then-confirm on the NEW ref, and stops on a failed adjust", async () => {
    const decisions: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      decisions.push(body);
      return new Response(
        JSON.stringify({
          outcome:
            body.op === "adjust"
              ? { kind: "reproposed", ref: "ref-2", expiresAt: 1 }
              : { kind: "confirmed", runId: "run-9", alreadyConfirmed: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const outcome = await adjustAndConfirmSchedule({
      ref: "ref-1",
      schedule: RECURRING,
      auth: null,
    });
    expect(outcome).toEqual({ kind: "confirmed", runId: "run-9", alreadyConfirmed: false });
    expect(decisions.map((d) => [d.op, d.ref])).toEqual([
      ["adjust", "ref-1"],
      ["confirm", "ref-2"],
    ]);

    decisions.length = 0;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: { kind: "error", message: "no good" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const refused = await adjustAndConfirmSchedule({
      ref: "ref-1",
      schedule: RECURRING,
      auth: null,
    });
    expect(refused).toEqual({ kind: "error", message: "no good" });
  });

  it("submitScheduleDecision carries the widget's credential when the caller is on the widget", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ outcome: { kind: "cancelled" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await submitScheduleDecision({ ref: "r", op: "cancel", auth: WIDGET_AUTH });
    const init = seen!;
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"]).toBe("cwu_user");
  });

  it("a non-2xx answers the uniform refusal — never a status code turned into a hint", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const outcome = await submitScheduleDecision({ ref: "r", op: "confirm", auth: null });
    expect(outcome.kind).toBe("not-permitted");
  });
});

// ---------------------------------------------------------------------------
// THE S9d REWORK (cinatra#2788, PR #2939 round 2).
//
// The maintainer rejected round 1 on four readings of the settled card. Three
// of them are removals the PLAN now states outright — PLAN: Agents Lifecycle
// (A) §7.2, amended 2026-08-23: "the same card, with the same option rows,
// shows the schedule as it stands — no label, no summary box" for the
// conversation, and "The schedule step on the run page and the review page
// shows the same form and nothing else — no summary box, no status label" for
// the two pages. The fourth is the two controls' names.
//
// These are written against the CARD rather than a page because the card is the
// one renderer of this kind on all four hosts: what it does not draw, no host
// can show.
// ---------------------------------------------------------------------------

describe("the rework — the step is the form and nothing else", () => {
  const PAGE_HOSTS = ["run_card", "page_gate_region"] as const;
  const ALL_HOSTS = ["chat_thread", "site_widget", "run_card", "page_gate_region"] as const;

  it("NO summary box and NO held-steps block on either page host", async () => {
    for (const host of PAGE_HOSTS) {
      mockTransport({ state: "settled" }, settledBody());
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      expect(
        view.container.querySelector('[data-conformance-id="scheduled-run-chrome"]'),
      ).toBeNull();
      expect(
        view.container.querySelector('[data-conformance-id="schedule-gated-steps"]'),
      ).toBeNull();
      expect(view.container.textContent).not.toContain("Trigger configuration");
      expect(view.container.textContent).not.toContain("Steps held until trigger fires");
      view.unmount();
      cleanup();
    }
  });

  it("NO status label — the word Armed is drawn on no host", async () => {
    for (const host of ALL_HOSTS) {
      mockTransport({ state: "settled" }, settledBody());
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      expect(
        view.container.querySelector('[data-conformance-id="schedule-armed-summary"]'),
      ).toBeNull();
      expect(view.container.textContent).not.toContain("Armed");
      view.unmount();
      cleanup();
    }
  });

  it("NO Open-the-run link on any host", async () => {
    for (const host of ALL_HOSTS) {
      mockTransport({ state: "settled" }, settledBody());
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      expect(
        view.container.querySelector('[data-conformance-id="schedule-open-run"]'),
      ).toBeNull();
      expect(view.container.textContent).not.toContain("Open the run");
      view.unmount();
      cleanup();
    }
  });

  it("the ONE control is named Cancel schedule — the data-action id is unchanged", async () => {
    mockTransport({ state: "settled" }, settledBody());
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-action="cancel-trigger-schedule"]')?.textContent,
    ).toContain("Cancel schedule");
    expect(container.textContent).not.toContain("Cancel trigger");
    expect(container.textContent).not.toContain("Release now");
    expect(container.textContent).not.toContain("Run now");
  });

  // cinatra#2972 REWROTE THIS DIALOG'S WORDS, because the act changed. It used
  // to promise "The run will stay paused", which described the DELETE this
  // control performed; the plan withdrew both halves — Cancel schedule "never
  // deletes the schedule or pauses the run".
  it("the confirm dialog says what stopping a schedule actually does", async () => {
    mockTransport({ state: "settled" }, settledBody());
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="cancel-trigger-schedule"]')!);
    const strip = container.querySelector(
      '[data-conformance-id="schedule-cancel-confirm"]',
    );
    expect(strip?.textContent).toContain("Stop this recurring schedule?");
    expect(strip?.textContent).toContain("Keep schedule");
    expect(strip?.textContent).toContain("Cancel schedule");
    expect(strip?.textContent).not.toContain("trigger");
    // The two promises the amendment struck out.
    expect(strip?.textContent).not.toContain("paused");
    expect(strip?.textContent).not.toContain("delete");
    // And no release dialog exists to open at all.
    expect(
      container.querySelector('[data-conformance-id="schedule-release-confirm"]'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE TWO CONFORMANCE FAILS OF THE S9d CAPTURE ROUND (PR #2939, C2 and C6)
//
// Both are the settled card drawing chrome plan (A) §7.2 does not define. They
// are pinned as their own block because each one is a sentence of the plan read
// literally, not a refinement of the shape the block above pins.
// ---------------------------------------------------------------------------

describe("the settled card draws the schedule as it stands, and nothing else", () => {
  const ALL_HOSTS = ["chat_thread", "site_widget", "run_card", "page_gate_region"] as const;

  /** A one-off whose time has PASSED — the state the plan closes to changes. */
  const FIRED_ONE_OFF: ProposedSchedule = {
    kind: "scheduled",
    runAt: "2020-03-04T09:00",
    timezone: "Europe/Berlin",
  };

  /**
   * C2 — an ADJUSTED-THEN-CONFIRMED schedule re-opens on the SETTLED rows.
   *
   * Plan (A) §7.2: "the same card, with the same option rows, shows the
   * schedule as it stands — no label, no summary box". `superseded` is the
   * resolver's answer to a sibling question (cinatra#2859) — whether THIS
   * card's own token holds the rows the family settled on — and the rows it
   * guards are already right, because the resolver reads them back off the
   * installed row. The plan defines no chrome for it, so the renderer draws
   * none: the card re-opens on the armed rows and says nothing above them.
   */
  it("a settled card marked superseded draws the ARMED rows and no supersede line", async () => {
    for (const host of ALL_HOSTS) {
      mockTransport(
        { state: "settled" },
        settledBody({
          superseded: true,
          scheduleCopy:
            "This card was adjusted before it was set — open the run to see the schedule that was set.",
        }),
      );
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      expect(
        view.container.querySelector('[data-conformance-id="schedule-superseded"]'),
      ).toBeNull();
      expect(view.container.textContent).not.toContain("adjusted before it was set");
      expect(view.container.textContent).not.toContain("open the run");
      // The rows are the ARMED ones and they are still the only thing above the
      // floor: a superseded card is an ordinary settled card to the reader.
      expect(
        (
          view.container.querySelector(
            '[data-field="recurring-timezone"]',
          ) as HTMLInputElement | null
        )?.value,
      ).toBe("Europe/Berlin");
      view.unmount();
      cleanup();
    }
  });

  /**
   * C6 — a FIRED one-off offers nothing to press.
   *
   * Plan (A) §7.2: "once a one-off has fired it cannot be changed", and **Save
   * changes** is defined for the changeable state only — "As long as the
   * schedule has not fired, you can change it". A disabled Save changes is
   * still the card offering the control the plan withdrew, so the fired card
   * draws no floor at all and its rows simply stand.
   *
   * THE BODY BELOW IS THE STATE THE SERVER ACTUALLY PRODUCES, not a setting of
   * a flag chosen to match the renderer's reading. Natural firing runs the
   * release job, which marks the trigger released (`markTriggerReleased` →
   * `releasedAt`), so the resolver reads back `released: true` — and with it
   * `canSave: false` and `canCancel: false`. An earlier draft
   * of this fix keyed off `canSave` alone and demanded `!released`, which is
   * the one shape a fired one-off never has; it is spelled out here so that
   * cannot come back.
   *
   * `trigger-schedule-proposal-adjust-lineage.test.ts` pins the same body
   * against the resolver itself, so this file is not the only place that says
   * what a fired one-off looks like.
   */
  it("a FIRED one-off draws NO floor, no operations, and read-only rows", async () => {
    for (const host of ALL_HOSTS) {
      mockTransport(
        { state: "settled" },
        settledBody({
          triggerType: "scheduled",
          schedule: FIRED_ONE_OFF,
          scheduleCopy: "Once, at 2020-03-04 09:00",
          canSave: false,
          canCancel: false,
          released: true,
          arming: false,
        }),
      );
      const view = renderOn(host);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      // NO FLOOR AT ALL (cinatra#2934, the FOURTH graded capture). The ratified
      // drawing at the pin this pull request records gives this exact state no
      // floor, no hairline and nothing to press, and plan (A) §7.2 says the
      // surface "shows the same form and nothing else — no summary box, no
      // status label". The reader still gets the reason: the prompt window
      // below the scheduler stays present and disabled and answers there.
      expect(
        view.container.querySelector('[data-action="save-schedule-changes"]'),
        host,
      ).toBeNull();
      expect(
        view.container.querySelector('[data-action="cancel-trigger-schedule"]'),
        host,
      ).toBeNull();
      expect(view.container.querySelector('[data-action="release-trigger-now"]'), host).toBeNull();
      expect(
        view.container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
        host,
      ).toBeNull();
      expect(
        view.container.querySelector('[data-action="confirm-schedule-proposal"]'),
        host,
      ).toBeNull();
      // AND NO STATUS LABEL AT ALL, of any kind (plan (A) §7.2). Not the
      // released line, and not the state's own sentence either: the card is the
      // form, and the sentence belongs to the window below the scheduler, which
      // is where the sibling suite pins it.
      expect(
        view.container.querySelector('[data-conformance-id="schedule-released"]'),
        host,
      ).toBeNull();
      expect(view.container.textContent, host).not.toContain("Released —");
      expect(view.container.textContent, host).not.toContain(
        SAVE_SCHEDULE_REFUSALS.firedOneOff,
      );
      // The rows stand — read-only, showing the schedule that fired. Since the
      // fifth graded proof set (cinatra#2934) that is read the way the drawing
      // draws it: "the values still legible, the pickers gone", so there is no
      // picker here to be disabled and the moment is legible as text.
      expect(
        view.container.querySelector('[data-field="schedule-run-at"]'),
        host,
      ).toBeNull();
      expect(
        view.container.querySelector('[data-readonly-field="schedule-run-at"]')?.textContent,
        host,
      ).toBe("2020-03-04T09:00");
      view.unmount();
      cleanup();
    }
  });

  /**
   * FIRING IS THE LINE, and this is the state on the other side of it. A
   * one-off whose moment has passed while the release job has not drained yet
   * has NOT fired: its gate is shut, so the card is not frozen and the floor
   * still stands with Save changes dead. What it no longer carries is a
   * **Cancel schedule**: cinatra#2972 made that control the recurring
   * schedule's alone (`canCancel: false` for every one-off), which is why the
   * body below differs from the one this test shipped with.
   */
  it("a one-off past its moment but NOT yet released keeps the floor it always had", async () => {
    mockTransport(
      { state: "settled" },
      settledBody({
        triggerType: "scheduled",
        schedule: FIRED_ONE_OFF,
        scheduleCopy: "Once, at 2020-03-04 09:00",
        canSave: false,
        canCancel: false,
        released: false,
        arming: false,
      }),
    );
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(true);
    // …and NO Cancel schedule: cinatra#2972 made that control the recurring
    // schedule's alone, so a one-off never carries it whatever its stamps say.
    expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
    expect(container.querySelector('[data-action="release-trigger-now"]')).toBeNull();
  });

  /**
   * THE ARMING/RELEASE RACE. The installer exposes the schedule to the
   * scheduler before it marks the install intent done, so a near-term one-off
   * can fire while the intent still reads as arming. The card must call that
   * fired — a floor standing over a schedule that has already run is the C6
   * failure with a different cause.
   */
  it("a one-off released while its install intent still reads as arming is fired", async () => {
    mockTransport(
      { state: "settled" },
      settledBody({
        triggerType: "scheduled",
        schedule: FIRED_ONE_OFF,
        scheduleCopy: "Once, at 2020-03-04 09:00",
        canSave: false,
        canCancel: false,
        released: true,
        arming: true,
      }),
    );
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull(),
    );
    // No floor (cinatra#2934, the fourth graded capture).
    expect(
      container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
    ).toBeNull();
    expect(container.querySelector('[data-action="save-schedule-changes"]')).toBeNull();
    // And NEITHER status line above the rows — this body satisfies both — since
    // each exists to explain a withheld control, and the floor now explains it
    // where the control is.
    expect(container.querySelector('[data-conformance-id="schedule-arming"]')).toBeNull();
    expect(container.textContent).not.toContain("Arming");
    expect(container.querySelector('[data-conformance-id="schedule-released"]')).toBeNull();
    expect(container.textContent).not.toContain("Released —");
  });

  /**
   * A confirm strip cannot outlive the floor that opened it. The card
   * re-resolves on focus without remounting `SettledPhase`, so a reader who
   * opens the Cancel-schedule question and comes back after the schedule has
   * been stopped would otherwise be left holding a live confirm button over a
   * card that no longer offers the operation.
   *
   * THE SUBJECT MOVED WITH THE CONTROL (cinatra#2972). It used to be a one-off
   * firing under an open strip; a one-off carries no Cancel schedule any more,
   * so the same property is pinned on the state that DOES have one — a
   * recurring schedule that was stopped while the strip was open, which is the
   * plan's own "and then makes the scheduler non-editable".
   */
  it("an open confirm strip is withdrawn when the card re-resolves as stopped", async () => {
    let settled = settledBody({ canSave: true, canCancel: true });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
      return new Response(
        JSON.stringify(
          isDecision
            ? { kind: "cancelled" }
            : { kind: "trigger_schedule_proposal", state: { state: "settled" }, body: settled },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="cancel-trigger-schedule"]')!);
    expect(
      container.querySelector('[data-conformance-id="schedule-cancel-confirm"]'),
    ).not.toBeNull();

    // The reader also starts editing the rows and never saves.
    fireEvent.change(container.querySelector('[data-field="recurring-timezone"]')!, {
      target: { value: "Pacific/Auckland" },
    });
    expect(
      (container.querySelector('[data-field="recurring-timezone"]') as HTMLInputElement).value,
    ).toBe("Pacific/Auckland");

    // The schedule is stopped underneath the open strip, and the card
    // re-resolves.
    settled = settledBody({ canSave: false, canCancel: false, stopped: true });
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        container.querySelector('[data-conformance-id="schedule-cancel-confirm"]'),
      ).toBeNull(),
    );
    expect(
      container.querySelector('[data-conformance-id="schedule-proposal-floor"]'),
    ).toBeNull();
    // AND THE UNSAVED EDIT IS GONE WITH IT. The rows now stand read-only, so
    // whatever they show is a claim about what is armed — it must be the
    // server's schedule, never the draft nobody saved. Read off the read-only
    // value the drawing puts there since the fifth graded proof set
    // (cinatra#2934); the picker itself is gone.
    expect(container.querySelector('[data-field="recurring-timezone"]')).toBeNull();
    expect(
      container.querySelector('[data-readonly-field="recurring-timezone"]')?.textContent,
    ).toBe("Europe/Berlin");
  });

  /**
   * THE CHANGEABLE STATE IS UNTOUCHED, and this is the half that makes the one
   * above a fix rather than a deletion: "As long as the schedule has not fired,
   * you can change it" (§7.2). A one-off still ahead of its time keeps the
   * whole floor, and so does a recurring schedule.
   */
  it("a one-off that has NOT fired keeps Save changes, and so does a recurring schedule", async () => {
    mockTransport(
      { state: "settled" },
      settledBody({
        triggerType: "scheduled",
        schedule: { kind: "scheduled", runAt: "2099-03-04T09:00", timezone: "Europe/Berlin" },
        scheduleCopy: "Once, at 2099-03-04 09:00",
        canSave: true,
      }),
    );
    const upcoming = renderOn("chat_thread");
    await waitFor(() =>
      expect(upcoming.container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    expect(isDisabled(upcoming.container.querySelector('[data-field="schedule-run-at"]'))).toBe(false);
    upcoming.unmount();
    cleanup();

    mockTransport({ state: "settled" }, settledBody());
    const recurring = renderOn("run_card");
    await waitFor(() =>
      expect(recurring.container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    expect(recurring.container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull();
    expect(recurring.container.querySelector('[data-action="release-trigger-now"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE PRISTINE SETTLED CARD STAYS PRISTINE WHEN THE THREAD MOVES (cinatra#3053)
//
// A settled card nobody touched drew **Save changes** at FULL strength the
// moment a SECOND run was dispatched into the same conversation — nothing
// pressed and nothing edited on that card. A live Save changes on an untouched
// card reads as unsaved changes the reader never made.
//
// WHY IT HAPPENED. `SettledPhase` seeds its `draft` ONCE at mount and is never
// remounted, while `edited` compared that seed against `body.schedule` — a PROP
// the thread refreshes underneath the card. `useLifecycleCardResolve` re-reads
// on the window `focus` event, a THREAD-WIDE signal every mounted lifecycle
// card shares, so a sibling run arriving re-resolved this card too; and a
// re-resolve does not have to answer byte-alike for one unchanged armed
// schedule (`selectionsFromInstalled` re-derives a one-off's `runAt` from the
// clock whenever the installed row carries no instant). One benign refresh
// therefore made a pristine card claim an edit.
//
// WHAT IS PINNED HERE. The control's strength derives from the card's OWN
// unsaved edits and from nothing else: a refresh cannot invent one, a refresh
// cannot erase one, and a real edit still lights it.
// ---------------------------------------------------------------------------

describe("a settled card's Save changes answers only to its own edits", () => {
  /**
   * The settled read-back as the server really derives it. Each resolve answers
   * for the SAME armed one-off, and each answers with a freshly derived `runAt`
   * — the drift `selectionsFromInstalled` produces when the installed row holds
   * no instant. The ARMED schedule has not changed at all — only the field the
   * server re-derives does, which is exactly why the card may neither call it
   * an edit nor draw it under the reader.
   */
  function driftingSettledTransport() {
    let resolves = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
      if (isDecision) {
        return new Response(JSON.stringify({ outcome: { kind: "saved" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      resolves += 1;
      return new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body: settledBody({
            triggerType: "scheduled",
            canCancel: false,
            scheduleCopy: "Once, on 21 August at 9:00 AM",
            schedule: {
              kind: "scheduled",
              runAt: `2026-08-21T09:0${resolves}`,
              timezone: "Europe/Berlin",
            },
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return () => resolves;
  }

  /** The thread-wide signal a second run's card arriving trips — the one every
   *  mounted lifecycle card re-reads on. */
  function aSiblingRunArrives() {
    fireEvent(window, new Event("focus"));
  }

  it("a second run arriving in the thread leaves an untouched card's Save changes quiet", async () => {
    const resolveCount = driftingSettledTransport();
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    // Settled, nothing edited: the quiet reading.
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(true);
    const firstRunAt = (
      container.querySelector('[data-field="schedule-run-at"]') as HTMLInputElement
    ).value;

    const before = resolveCount();
    aSiblingRunArrives();
    await waitFor(() => expect(resolveCount()).toBeGreaterThan(before));

    // NOTHING WAS PRESSED AND NOTHING WAS EDITED, so the control must not have
    // moved. This is the defect: it used to go live here.
    await waitFor(() =>
      expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(
        true,
      ),
    );
    // AND THE ROWS MUST NOT HAVE MOVED EITHER. The re-derived `runAt` the
    // read-back answers with is clock-derived fallback, not a run time anybody
    // armed, so it may not be drawn under a reader who is looking at the card.
    // A fix that quietened the control by letting the refresh rewrite the draft
    // would trade one wrong reading for another; this pins that it does not.
    expect(
      (container.querySelector('[data-field="schedule-run-at"]') as HTMLInputElement).value,
    ).toBe(firstRunAt);
  });

  it("the reader's own unsaved edit survives a sibling run's refresh and keeps the control live", async () => {
    const resolveCount = driftingSettledTransport();
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="schedule-timezone"]')).not.toBeNull(),
    );
    fireEvent.change(container.querySelector('[data-field="schedule-timezone"]')!, {
      target: { value: "Europe/Lisbon" },
    });
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(false);

    const before = resolveCount();
    aSiblingRunArrives();
    await waitFor(() => expect(resolveCount()).toBeGreaterThan(before));

    // An edit in progress is the reader's, and a refresh nobody asked for does
    // not get to throw it away or to disarm the control that saves it.
    await waitFor(() =>
      expect(
        (container.querySelector('[data-field="schedule-timezone"]') as HTMLInputElement).value,
      ).toBe("Europe/Lisbon"),
    );
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(false);
  });

  it("a landed save keeps its rows and its quiet control when the read-back drifts", async () => {
    const resolveCount = driftingSettledTransport();
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="schedule-timezone"]')).not.toBeNull(),
    );
    fireEvent.change(container.querySelector('[data-field="schedule-timezone"]')!, {
      target: { value: "Europe/Lisbon" },
    });
    fireEvent.click(container.querySelector('[data-action="save-schedule-changes"]')!);

    // The save lands, so the control goes quiet — what was saved is what is
    // armed, and the card says so without waiting on the read.
    await waitFor(() =>
      expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(
        true,
      ),
    );

    // Now the thread refreshes, and the read-back answers for the SAME armed
    // schedule with a re-derived field. The saved rows must survive it, and the
    // control must stay quiet: a refresh may neither roll a landed save back nor
    // re-arm a control over changes the reader already saved.
    const before = resolveCount();
    aSiblingRunArrives();
    await waitFor(() => expect(resolveCount()).toBeGreaterThan(before));
    expect(
      (container.querySelector('[data-field="schedule-timezone"]') as HTMLInputElement).value,
    ).toBe("Europe/Lisbon");
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(true);
  });

  it("an actual edit still lights the control on a settled card", async () => {
    mockTransport({ state: "settled" }, settledBody());
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(true);
    fireEvent.change(container.querySelector('[data-field="recurring-timezone"]')!, {
      target: { value: "Europe/Lisbon" },
    });
    expect(isDisabled(container.querySelector('[data-action="save-schedule-changes"]'))).toBe(false);
  });
});
