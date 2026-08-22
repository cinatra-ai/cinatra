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
    triggerType: "recurring",
    scheduleCopy: "Every weekday at 9:00 AM",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canCancel: true,
    canRelease: false,
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
  it("proposal: the option rows, the chosen row marked, the duration, and the Adjust · Confirm floor", async () => {
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
    expect(container.querySelector('[data-action="adjust-schedule-proposal"]')).not.toBeNull();
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

  it("settled: the trigger's chrome — configuration, held steps, and the two quiet controls", async () => {
    mockTransport({ state: "settled" }, settledBody({ canRelease: true }));
    const { container } = renderOn("run_card");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).not.toBeNull(),
    );
    expect(container.textContent).toContain("Trigger configuration");
    expect(container.textContent).toContain("Every weekday at 9:00 AM");
    expect(container.textContent).toContain("Europe/Berlin");
    expect(container.textContent).toContain("Steps held until trigger fires");
    expect(container.textContent).toContain("No side-effect steps detected.");
    expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull();
    expect(container.querySelector('[data-action="release-trigger-now"]')).not.toBeNull();
    // The option rows are GONE — the settled card is the chrome, not both.
    expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).toBeNull();
  });

  it("settled: Release now is admin-only — a non-admin body draws no control at all", async () => {
    mockTransport({ state: "settled" }, settledBody({ canRelease: false }));
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-action="release-trigger-now"]')).toBeNull();
    expect(isDisabled(container.querySelector('[data-action="cancel-trigger-schedule"]'))).toBe(false);
  });

  it("settled: ARMING withholds Cancel and says why, rather than drawing a control that fails on press", async () => {
    mockTransport(
      { state: "settled" },
      settledBody({ arming: true, canCancel: false, canRelease: false }),
    );
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-arming"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-action="cancel-trigger-schedule"]'))).toBe(true);
  });

  it("settled: an ALREADY-RELEASED trigger offers neither control and reads back why", async () => {
    mockTransport(
      { state: "settled" },
      settledBody({ released: true, canCancel: false, canRelease: false }),
    );
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-released"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-action="cancel-trigger-schedule"]'))).toBe(true);
    expect(container.querySelector('[data-action="release-trigger-now"]')).toBeNull();
  });

  it("expired: the card STAYS VISIBLE with Adjust to propose again, and no Confirm", async () => {
    mockTransport({ state: "settled" }, EXPIRED_BODY);
    const { container } = renderOn("chat_thread");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="schedule-proposal-expired"]')).not.toBeNull(),
    );
    // The rows the reader last saw, so Adjust re-opens them rather than a blank form.
    expect(container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull();
    expect(container.querySelector('[data-action="adjust-schedule-proposal"]')).not.toBeNull();
    // There is nothing to confirm: the window closed and the token is unspendable.
    expect(container.querySelector('[data-action="confirm-schedule-proposal"]')).toBeNull();
    expect(container.querySelector('[data-lifecycle-card-phase="expired"]')).not.toBeNull();
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

      // The SETTLED half of the same set, on the same host: the trigger's own
      // chrome and the two quiet controls §VI closes on.
      mockTransport({ state: "settled" }, settledBody({ canRelease: true }));
      const settled = renderOn(host);
      await waitFor(() =>
        expect(
          settled.container.querySelector('[data-conformance-id="scheduled-run-chrome"]'),
        ).not.toBeNull(),
      );
      expect(
        settled.container.querySelectorAll('[data-conformance-id="scheduled-run-chrome"]'),
      ).toHaveLength(1);
      expect(
        settled.container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]'),
      ).toHaveLength(1);
      const settledRoot = settled.container.querySelector(
        '[data-lifecycle-card="trigger_schedule_proposal"]',
      );
      expect(settledRoot?.getAttribute("data-lifecycle-card-host")).toBe(host);
      expect(settledRoot?.getAttribute("data-lifecycle-card-state")).toBe("settled");
      expect(
        settled.container.querySelector('[data-action="cancel-trigger-schedule"]'),
      ).not.toBeNull();
      expect(
        settled.container.querySelector('[data-action="release-trigger-now"]'),
      ).not.toBeNull();
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

  it("the widget draws NO cookie-bound affordance: the deep link into the run is first-party only", async () => {
    mockTransport({ state: "settled" }, settledBody());
    const widget = renderOn("site_widget");
    await waitFor(() =>
      expect(widget.container.querySelector('[data-conformance-id="scheduled-run-chrome"]')).not.toBeNull(),
    );
    expect(widget.container.querySelector('[data-conformance-id="schedule-open-run"]')).toBeNull();
    widget.unmount();
    cleanup();

    mockTransport({ state: "settled" }, settledBody());
    const chat = renderOn("chat_thread");
    await waitFor(() =>
      expect(chat.container.querySelector('[data-conformance-id="schedule-open-run"]')).not.toBeNull(),
    );
  });

  it("Cancel asks first, in the Trigger tab's own words, and only then acts", async () => {
    const fetchMock = mockTransport({ state: "settled" }, settledBody(), { kind: "cancelled" });
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="cancel-trigger-schedule"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="cancel-trigger-schedule"]')!);
    // Asked, not done.
    const strip = container.querySelector('[data-conformance-id="schedule-cancel-confirm"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Cancel scheduled trigger?");
    expect(strip?.textContent).toContain("The run will stay paused.");
    expect(decisionBodies(fetchMock)).toHaveLength(0);

    fireEvent.click(strip!.querySelector('[data-action="confirm-destructive"]')!);
    await waitFor(() => expect(lastDecision(fetchMock).op).toBe("cancel"));
  });

  it("Release now asks first with its irreversibility warning, then reaches the release operation", async () => {
    const fetchMock = mockTransport({ state: "settled" }, settledBody({ canRelease: true }), {
      kind: "released",
    });
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-action="release-trigger-now"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="release-trigger-now"]')!);
    const strip = container.querySelector('[data-conformance-id="schedule-release-confirm"]');
    expect(strip?.textContent).toContain("Release trigger now?");
    expect(strip?.textContent).toContain("This cannot be undone.");
    fireEvent.click(strip!.querySelector('[data-action="confirm-destructive"]')!);
    await waitFor(() => expect(lastDecision(fetchMock).op).toBe("release"));
  });

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
// ADJUST — re-propose, in place
// ---------------------------------------------------------------------------

describe("§VI Adjust re-opens the same rows in place", () => {
  it("the rows are read-only until Adjust is pressed", async () => {
    mockTransport({ state: "pending", canDecide: true, canComment: false }, proposalBody());
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-field="recurring-timezone"]')).not.toBeNull(),
    );
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(true);
    fireEvent.click(container.querySelector('[data-action="adjust-schedule-proposal"]')!);
    expect(isDisabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(false);
    // Still ONE set of rows — Adjust opens them, it does not add a second form.
    expect(container.querySelectorAll('[data-conformance-id="schedule-option-rows"]')).toHaveLength(1);
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
      expect(container.querySelector('[data-action="adjust-schedule-proposal"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-action="adjust-schedule-proposal"]')!);
    // The reader corrects the row in place. (The timezone field is driven here
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
