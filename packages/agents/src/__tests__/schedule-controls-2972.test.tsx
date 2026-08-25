// @vitest-environment jsdom
//
// SCHEDULE CONTROLS, AS PLAN (A) §7 WAS AMENDED ON 2026-08-25 (cinatra#2972).
//
// This file is the renderer's half of the five points the issue makes. Each
// `describe` below quotes the plan sentence it exists for, and every body it
// mounts is the shape the RESOLVER actually produces for that state — never a
// flag set to make the renderer agree with itself.
//
// The plan sentences (PLAN: Agents Lifecycle (A) §7.2, amended 2026-08-25):
//
//   "once a run set to **Run right after setup** or **Schedule for later** has
//    fired, its schedule cannot be changed any more; a run set to **Recurring**
//    that has fired keeps its scheduler editable — the same rows and **Save
//    changes**, and a change applies to its future runs — and shows **Cancel
//    schedule**, which stops the recurring schedule and then makes the
//    scheduler non-editable."
//
//   "its one control is **Cancel schedule**, shown only for a recurring
//    schedule that has fired once — it stops the recurring schedule and then
//    makes the scheduler non-editable; there is no Run now."
//
// §7.4's as-designed step 6 says the same in the other voice: "From the
// schedule step of a recurring schedule that has fired once: **Cancel
// schedule** → **End state: stopped** (the scheduler then non-editable)".

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

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "run-scoped-ref",
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

const PAST_ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2020-03-04T09:00",
  timezone: "Europe/Berlin",
};

function settled(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>>,
): TriggerScheduleProposalViewBody {
  return {
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
    canCancel: false,
    ...over,
  };
}

/** THE STATES THE RESOLVER PRODUCES, named once so every test below mounts the
 *  same body the server would have sent for that schedule. */
const BODIES = {
  /** "Run right after setup", after it ran. `releasedAt` is stamped, so
   *  `released: true`, and `canSaveInstalled` refuses on it. */
  immediateFired: settled({
    triggerType: "immediate",
    schedule: { kind: "immediate" },
    scheduleCopy: "Runs right after setup",
    released: true,
    canSave: false,
    canCancel: false,
  }),
  /** "Schedule for later", after it fired. Same stamp, same refusals. */
  oneOffFired: settled({
    triggerType: "scheduled",
    schedule: PAST_ONE_OFF,
    scheduleCopy: "Once, at 2020-03-04 09:00",
    released: true,
    canSave: false,
    canCancel: false,
  }),
  /** RECURRING, before its first tick: editable, no Cancel schedule yet. */
  recurringUnfired: settled({ canSave: true, canCancel: false }),
  /** RECURRING, after its first tick. `released` stays FALSE — a tick opens the
   *  COPY's gate, never this run's — and the tick's own stamp is what the
   *  resolver turned into `canCancel: true`. */
  recurringFired: settled({ canSave: true, canCancel: true }),
  /** RECURRING, stopped by Cancel schedule. */
  recurringStopped: settled({ canSave: false, canCancel: false, stopped: true }),
} as const;

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

function mount(
  body: TriggerScheduleProposalViewBody,
  host: "chat_thread" | "site_widget" | "run_card" | "page_gate_region",
  onDecision?: (payload: Record<string, unknown>) => void,
) {
  const state: LifecycleCardState = { state: "settled" };
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    if (isDecision && onDecision) {
      onDecision(JSON.parse(init!.body as string) as Record<string, unknown>);
    }
    return new Response(
      JSON.stringify(
        isDecision
          ? { outcome: { kind: "cancelled" } }
          : { kind: "trigger_schedule_proposal", state, body },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // The widget proves its reads with a broker credential, and the card draws
  // nothing at all for a widget subtree that has none — so the host frame is
  // supplied exactly as the shipped surface supplies it.
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

const rows = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-option-rows"]');
const floor = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-proposal-floor"]');
const save = (c: HTMLElement) => c.querySelector('[data-action="save-schedule-changes"]');
const cancel = (c: HTMLElement) =>
  c.querySelector('[data-action="cancel-trigger-schedule"]');
const disabled = (el: Element | null) =>
  el === null ? null : el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

// ---------------------------------------------------------------------------
// POINT 1 — "once a run set to Run right after setup or Schedule for later has
// fired, its schedule cannot be changed any more"
// ---------------------------------------------------------------------------

describe("point 1 — a fired one-off or immediate run freezes", () => {
  for (const [name, body] of [
    ["Run right after setup", BODIES.immediateFired],
    ["Schedule for later", BODIES.oneOffFired],
  ] as const) {
    it(`${name}, after it fired: read-only rows and NO controls, on every host`, async () => {
      for (const host of [
        "chat_thread",
        "site_widget",
        "run_card",
        "page_gate_region",
      ] as const) {
        const view = mount(body, host);
        await waitFor(() => expect(rows(view.container)).not.toBeNull());
        // The whole floor is gone — not a disabled control in it.
        expect(floor(view.container), `${name}/${host}`).toBeNull();
        expect(save(view.container), `${name}/${host}`).toBeNull();
        expect(cancel(view.container), `${name}/${host}`).toBeNull();
        expect(view.container.textContent, `${name}/${host}`).not.toContain("Save changes");
        expect(view.container.textContent, `${name}/${host}`).not.toContain("Cancel schedule");
        // And no status label stands in for the withheld controls.
        expect(
          view.container.querySelector('[data-conformance-id="schedule-released"]'),
          `${name}/${host}`,
        ).toBeNull();
        view.unmount();
        cleanup();
      }
    });
  }

  it("the rows of a fired one-off are read-only, showing the schedule that fired", async () => {
    const { container } = mount(BODIES.oneOffFired, "run_card");
    await waitFor(() => expect(rows(container)).not.toBeNull());
    expect(disabled(container.querySelector('[data-field="schedule-run-at"]'))).toBe(true);
    expect(
      (container.querySelector('[data-field="schedule-run-at"]') as HTMLInputElement).value,
    ).toBe("2020-03-04T09:00");
  });
});

// ---------------------------------------------------------------------------
// POINT 2 — "a run set to Recurring that has fired keeps its scheduler editable
// — the same rows and Save changes … — and shows Cancel schedule"
// ---------------------------------------------------------------------------

describe("point 2 — a fired recurring schedule stays editable", () => {
  it("the rows are LIVE and Save changes is there, on the page step", async () => {
    const { container } = mount(BODIES.recurringFired, "run_card");
    await waitFor(() => expect(rows(container)).not.toBeNull());
    expect(floor(container)).not.toBeNull();
    expect(save(container)).not.toBeNull();
    expect(disabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(false);
  });

  it("…and in the conversation too, where Save changes is the card's whole floor", async () => {
    for (const host of ["chat_thread", "site_widget"] as const) {
      const view = mount(BODIES.recurringFired, host);
      await waitFor(() => expect(rows(view.container)).not.toBeNull());
      expect(save(view.container), host).not.toBeNull();
      expect(disabled(view.container.querySelector('[data-field="recurring-timezone"]')), host).toBe(
        false,
      );
      // Cancel schedule belongs to the page step, not to the conversation.
      expect(cancel(view.container), host).toBeNull();
      view.unmount();
      cleanup();
    }
  });

  it("a CHANGED row posts `save` on the card's own ref — the change that applies to future runs", async () => {
    const sent: Record<string, unknown>[] = [];
    const { container } = mount(BODIES.recurringFired, "run_card", (p) => sent.push(p));
    await waitFor(() => expect(rows(container)).not.toBeNull());
    fireEvent.change(container.querySelector('[data-field="recurring-timezone"]')!, {
      target: { value: "Europe/Lisbon" },
    });
    await waitFor(() => expect(disabled(save(container))).toBe(false));
    fireEvent.click(save(container)!);
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({
      kind: "trigger_schedule_proposal",
      ref: "run-scoped-ref",
      op: "save",
    });
  });

  it("shows Cancel schedule — the control §7.2 gives exactly this state", async () => {
    const { container } = mount(BODIES.recurringFired, "run_card");
    await waitFor(() => expect(cancel(container)).not.toBeNull());
    expect(cancel(container)?.textContent).toContain("Cancel schedule");
  });
});

// ---------------------------------------------------------------------------
// POINT 3 — "Cancel schedule appears only for a recurring schedule that has
// fired once; pressed, it stops the recurring schedule and then makes the
// scheduler non-editable. It never deletes the schedule or pauses the run."
// ---------------------------------------------------------------------------

describe("point 3 — Cancel schedule, and only where the plan puts it", () => {
  it("is ABSENT for a recurring schedule that has NOT fired yet", async () => {
    const { container } = mount(BODIES.recurringUnfired, "run_card");
    await waitFor(() => expect(rows(container)).not.toBeNull());
    // The floor is still there — the schedule is changeable — but the control
    // is not drawn at all, rather than drawn dead.
    expect(floor(container)).not.toBeNull();
    expect(save(container)).not.toBeNull();
    expect(cancel(container)).toBeNull();
    expect(container.textContent).not.toContain("Cancel schedule");
  });

  it("is ABSENT for a one-off, fired or not", async () => {
    for (const body of [
      BODIES.oneOffFired,
      settled({
        triggerType: "scheduled",
        schedule: { kind: "scheduled", runAt: "2099-03-04T09:00", timezone: "Europe/Berlin" },
        scheduleCopy: "Once, at 2099-03-04 09:00",
        canSave: true,
        canCancel: false,
      }),
    ]) {
      const view = mount(body, "run_card");
      await waitFor(() => expect(rows(view.container)).not.toBeNull());
      expect(cancel(view.container)).toBeNull();
      view.unmount();
      cleanup();
    }
  });

  it("asks first, and the words never promise a delete or a pause", async () => {
    const { container } = mount(BODIES.recurringFired, "run_card");
    await waitFor(() => expect(cancel(container)).not.toBeNull());
    fireEvent.click(cancel(container)!);
    const strip = container.querySelector(
      '[data-conformance-id="schedule-cancel-confirm"]',
    );
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Stop this recurring schedule?");
    expect(strip?.textContent).not.toContain("paused");
    expect(strip?.textContent).not.toContain("delete");
  });

  it("pressed, it posts `cancel` on the card's own ref", async () => {
    const sent: Record<string, unknown>[] = [];
    const { container } = mount(BODIES.recurringFired, "run_card", (p) => sent.push(p));
    await waitFor(() => expect(cancel(container)).not.toBeNull());
    fireEvent.click(cancel(container)!);
    fireEvent.click(
      container.querySelector(
        '[data-conformance-id="schedule-cancel-confirm"] button:last-of-type',
      )!,
    );
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ op: "cancel", ref: "run-scoped-ref" });
  });

  it("AFTERWARDS the scheduler is non-editable — the stopped card has no floor", async () => {
    const { container } = mount(BODIES.recurringStopped, "run_card");
    await waitFor(() => expect(rows(container)).not.toBeNull());
    expect(floor(container)).toBeNull();
    expect(save(container)).toBeNull();
    expect(cancel(container)).toBeNull();
    // The schedule is still DRAWN — stopping it is not deleting it.
    expect(disabled(container.querySelector('[data-field="recurring-timezone"]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POINT 4 — "there is no Run now"
// ---------------------------------------------------------------------------

describe("point 4 — no Run now, anywhere, in any state", () => {
  it("control count is 0 across every host × every settled state", async () => {
    for (const host of [
      "chat_thread",
      "site_widget",
      "run_card",
      "page_gate_region",
    ] as const) {
      for (const [name, body] of Object.entries(BODIES)) {
        const view = mount(body, host);
        await waitFor(() => expect(rows(view.container)).not.toBeNull());
        expect(
          view.container.querySelectorAll('[data-action="release-trigger-now"]').length,
          `${host}/${name}`,
        ).toBe(0);
        expect(view.container.textContent, `${host}/${name}`).not.toContain("Run now");
        expect(view.container.textContent, `${host}/${name}`).not.toContain("Release now");
        expect(
          view.container.querySelector('[data-conformance-id="schedule-release-confirm"]'),
          `${host}/${name}`,
        ).toBeNull();
        view.unmount();
        cleanup();
      }
    }
  });
});
