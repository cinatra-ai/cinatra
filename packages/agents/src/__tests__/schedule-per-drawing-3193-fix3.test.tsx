// @vitest-environment jsdom
//
// THE SECOND GRADED PROOF ROUND'S SIX DEPARTURES (cinatra#3174, fix leg 3).
//
// Every assertion below quotes the ratified drawing's section VI, which is the
// only anchor this card is graded against.
//
//  1. CRITERION 3 — "The card is the scheduling step, in the turn — and it is
//     the only thing drawn." None of the section's five example turns carries a
//     monospace chip, a run id or a status token. The graded regression-smoke
//     frame drew "Dispatched `pkg` (runId: `…`, status: `queued`)" over a card
//     whose one-off had already been released and spent.
//
//  2. CRITERION 4 — the fired-recurring turn has its own line: "It is still
//     recurring, so the rows below still take a change — it applies to the runs
//     still to come." The graded frame drew the never-fired wait sentence.
//
//  3. THE FIRED-RECURRING FLOOR — the section's reading table gives that
//     reading "Save changes · Cancel schedule", its example draws both in the
//     CHAT THREAD, and its closing callout says so in words: "Wherever a
//     schedule is read — this card, the run's schedule step …, the widget — it
//     is drawn as this form in one of the five readings above… Cancel schedule
//     appears only where the schedule is recurring."
//
//  4. THE SPENT ONE-OFF — "Only a one-off … reaches this reading", and it is
//     the trigger's own record that says a one-off fired. The round measured
//     two real firings whose run rows never left `pending_approval` with
//     `started_at` NULL, and the card drew the configured reading over both.
//
//  5. THE DURATION LINE — "Estimated run duration" is drawn beneath the rows in
//     every one of the five pictures. The round measured it in none of eight
//     frames.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-per-drawing-3193-fix3.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import {
  LifecycleCardSurfaceProvider,
  ScheduleReadingReport,
  type ScheduleCardReading,
} from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";
import { scheduleFiredOnce } from "../trigger-schedule-proposal-service";
import { DURATION_LINE_NO_ESTIMATE } from "../duration-copy";
import {
  RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE,
  RUN_START_SCHEDULE_FIRED_SENTENCE,
  RUN_START_SCHEDULE_WAIT_CLAUSE,
  correctRunStartSentenceForFiredRecurringSchedule,
  correctRunStartSentenceForFiredSchedule,
  describeStartedRun,
} from "../run-status";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CRITERION 4 — the fired-recurring turn's own sentence
// ---------------------------------------------------------------------------

describe("criterion 4 — the fired recurring reading has its own line", () => {
  it("is the drawing's sentence, whole", () => {
    expect(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE).toBe(
      "It is still recurring, so the rows below still take a change — " +
        "it applies to the runs still to come.",
    );
  });

  it("is not the never-fired wait sentence, and not the spent one-off's either", () => {
    expect(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE).not.toBe(
      RUN_START_SCHEDULE_WAIT_CLAUSE,
    );
    expect(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE).not.toBe(
      RUN_START_SCHEDULE_FIRED_SENTENCE,
    );
  });

  it("replaces the platform's own sentence for the run it names, chips and all", () => {
    const line = describeStartedRun({
      packageName: "@cinatra-ai/blog-idea-generator",
      runId: "c089d865",
      status: "queued",
    });
    expect(line).toContain("runId:");
    const corrected = correctRunStartSentenceForFiredRecurringSchedule({
      text: line,
      runId: "c089d865",
    });
    expect(corrected).toBe(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
    expect(corrected).not.toContain("Dispatched");
    expect(corrected).not.toContain("runId:");
    expect(corrected).not.toContain("status:");
    expect(corrected).not.toContain("`");
  });

  it("rewrites a standing wait clause where this is the turn's only schedule run", () => {
    const corrected = correctRunStartSentenceForFiredRecurringSchedule({
      text: RUN_START_SCHEDULE_WAIT_CLAUSE,
      runId: "c089d865",
      scheduleRunIds: ["c089d865"],
      firedScheduleRunIds: ["c089d865"],
    });
    expect(corrected).toBe(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
  });

  it("is idempotent — a corrected line is left byte-identical", () => {
    const once = correctRunStartSentenceForFiredRecurringSchedule({
      text: describeStartedRun({ packageName: "p", runId: "r1", status: "queued" }),
      runId: "r1",
    });
    expect(
      correctRunStartSentenceForFiredRecurringSchedule({ text: once, runId: "r1" }),
    ).toBe(once);
  });

  it("leaves another run's line alone", () => {
    const other = describeStartedRun({ packageName: "p", runId: "r2", status: "queued" });
    expect(
      correctRunStartSentenceForFiredRecurringSchedule({ text: other, runId: "r1" }),
    ).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// CRITERION 3 — no chip and no status token once the run is past the waiting
// readings
// ---------------------------------------------------------------------------

describe("criterion 3 — the turn past the waiting readings speaks in prose", () => {
  it("the spent one-off's corrected line carries no chip, no run id, no status", () => {
    const line = describeStartedRun({
      packageName: "@cinatra-ai/blog-idea-generator",
      runId: "4b49ac92",
      status: "queued",
    });
    const corrected = correctRunStartSentenceForFiredSchedule({
      text: line,
      runId: "4b49ac92",
    });
    expect(corrected).toBe(RUN_START_SCHEDULE_FIRED_SENTENCE);
    for (const token of ["`", "runId:", "status:", "queued", "Dispatched"]) {
      expect(corrected).not.toContain(token);
    }
  });

  it("neither reading's line contains a backtick at all", () => {
    expect(RUN_START_SCHEDULE_FIRED_SENTENCE).not.toContain("`");
    expect(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE).not.toContain("`");
    expect(RUN_START_SCHEDULE_WAIT_CLAUSE).not.toContain("`");
  });
});

// ---------------------------------------------------------------------------
// THE SPENT ONE-OFF — elected off the trigger's own record
// ---------------------------------------------------------------------------

const NOW = new Date();

describe("a spent one-off is spent on the trigger's record, not the run's status", () => {
  // The round's own rows: released_at stamped, started_at NULL, status
  // pending_approval, because the run's next gate was never answered.
  it("is FIRED for the round's two real one-off firings", () => {
    for (const triggerType of ["immediate", "scheduled"] as const) {
      expect(
        scheduleFiredOnce({
          triggerType,
          releasedAt: NOW,
          lastFiredAt: null,
          run: { status: "pending_approval", startedAt: null },
        }),
        triggerType,
      ).toBe(true);
    }
  });

  it("is FIRED even where the run row cannot be read at all", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "immediate",
        releasedAt: NOW,
        lastFiredAt: null,
        run: null,
      }),
    ).toBe(true);
  });

  it("is NOT fired before the gate has opened", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "scheduled",
        releasedAt: null,
        lastFiredAt: null,
        run: { status: "running", startedAt: NOW },
      }),
    ).toBe(false);
  });

  it("leaves the recurring family on its own tick stamp", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "recurring",
        releasedAt: NOW,
        lastFiredAt: null,
        run: { status: "completed", startedAt: NOW },
      }),
    ).toBe(false);
    expect(
      scheduleFiredOnce({
        triggerType: "recurring",
        releasedAt: null,
        lastFiredAt: NOW,
        run: null,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The card itself
// ---------------------------------------------------------------------------

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "fix3-ref",
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

const ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2026-07-14T09:00",
  timezone: "Europe/Berlin",
};

function settled(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>>,
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Weekly cohort sweep",
    runId: "run-3193-fix3",
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

/** RECURRING, after its first tick: the reading the drawing gives both
 *  controls. */
const FIRED_RECURRING = settled({ canSave: true, canCancel: true });

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

type Host = "chat_thread" | "site_widget" | "run_card" | "page_gate_region";

function mount(
  body: TriggerScheduleProposalViewBody,
  opts: {
    host?: Host;
    firedOnce?: boolean;
    durationCopy?: string | null;
    onDecision?: (payload: Record<string, unknown>) => void;
    onReading?: (reading: ScheduleCardReading) => void;
  } = {},
) {
  const host: Host = opts.host ?? "chat_thread";
  const state: LifecycleCardState =
    body.phase === "settled"
      ? { state: "settled" }
      : { state: "pending", canDecide: true, canComment: false };
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const isDecision = typeof init?.body === "string" && init.body.includes('"op"');
    if (isDecision && opts.onDecision) {
      opts.onDecision(JSON.parse(init!.body as string) as Record<string, unknown>);
    }
    return new Response(
      JSON.stringify(
        isDecision
          ? { outcome: { kind: "cancelled" } }
          : {
              kind: "trigger_schedule_proposal",
              state,
              body,
              ...(opts.firedOnce ? { firedOnce: true } : {}),
              ...(opts.durationCopy === undefined
                ? {}
                : { durationCopy: opts.durationCopy }),
            },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const card = <ScheduleProposalCard view={VIEW} />;
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
      frame={host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined}
    >
      {opts.onReading ? (
        <ScheduleReadingReport onReading={opts.onReading}>{card}</ScheduleReadingReport>
      ) : (
        card
      )}
    </LifecycleCardSurfaceProvider>,
  );
}

const rows = (c: HTMLElement) =>
  c.querySelector('[data-conformance-id="schedule-option-rows"]');
const cancel = (c: HTMLElement) =>
  c.querySelector('[data-action="cancel-trigger-schedule"]');
const save = (c: HTMLElement) => c.querySelector('[data-action="save-schedule-changes"]');

describe("the fired recurring floor carries Cancel schedule beside Save changes", () => {
  it("draws both, on every host the drawing names", async () => {
    for (const host of [
      "chat_thread",
      "site_widget",
      "run_card",
      "page_gate_region",
    ] as const) {
      const view = mount(FIRED_RECURRING, { host });
      await waitFor(() => expect(rows(view.container)).not.toBeNull());
      expect(save(view.container), host).not.toBeNull();
      expect(cancel(view.container), host).not.toBeNull();
      expect(cancel(view.container)?.textContent, host).toContain("Cancel schedule");
      view.unmount();
      cleanup();
    }
  });

  it("is still absent where the schedule is not recurring-and-fired", async () => {
    const view = mount(settled({ canCancel: false }));
    await waitFor(() => expect(rows(view.container)).not.toBeNull());
    expect(cancel(view.container)).toBeNull();
  });

  it("presses through to the shipped cancel road, in the conversation", async () => {
    const sent: Record<string, unknown>[] = [];
    const { container } = mount(FIRED_RECURRING, {
      host: "chat_thread",
      onDecision: (p) => sent.push(p),
    });
    await waitFor(() => expect(cancel(container)).not.toBeNull());
    fireEvent.click(cancel(container)!);
    const confirm = await waitFor(() => {
      const strip = container.querySelector(
        '[data-conformance-id="schedule-cancel-confirm"]',
      );
      expect(strip).not.toBeNull();
      return strip as Element;
    });
    const press = Array.from(confirm.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Cancel schedule"),
    );
    expect(press).toBeDefined();
    fireEvent.click(press!);
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({
      kind: "trigger_schedule_proposal",
      ref: "fix3-ref",
      op: "cancel",
    });
  });
});

describe("the card reports the fired recurring reading to its turn", () => {
  it("reports `fired-recurring`, distinct from the neutral reading", async () => {
    const seen: ScheduleCardReading[] = [];
    const { container } = mount(FIRED_RECURRING, {
      firedOnce: true,
      onReading: (r) => seen.push(r),
    });
    await waitFor(() => expect(rows(container)).not.toBeNull());
    await waitFor(() => expect(seen).toContain("fired-recurring"));
    expect(
      container
        .querySelector('[data-conformance-id="schedule-proposal-card"]')
        ?.getAttribute("data-schedule-reading"),
    ).toBe("fired-recurring");
  });

  it("still reports `spent-one-off` for the fired one-off", async () => {
    const seen: ScheduleCardReading[] = [];
    const { container } = mount(
      settled({ triggerType: "scheduled", schedule: ONE_OFF, canSave: false, released: true }),
      { firedOnce: true, onReading: (r) => seen.push(r) },
    );
    await waitFor(() => expect(rows(container)).not.toBeNull());
    await waitFor(() => expect(seen).toContain("spent-one-off"));
  });
});

describe("the estimated duration line is drawn beneath the rows in every reading", () => {
  const READINGS: [string, TriggerScheduleProposalViewBody, boolean][] = [
    ["configured", settled({}), false],
    ["fired-recurring", FIRED_RECURRING, true],
    [
      "fired-one-off",
      settled({ triggerType: "scheduled", schedule: ONE_OFF, canSave: false, released: true }),
      true,
    ],
  ];

  for (const [name, body, firedOnce] of READINGS) {
    it(`draws the value it was given — ${name}`, async () => {
      const { container } = mount(body, { firedOnce, durationCopy: "About 45s – 3.4 hr." });
      await waitFor(() => expect(rows(container)).not.toBeNull());
      expect(container.textContent).toContain("Estimated run duration");
      expect(
        container.querySelector('[data-conformance-id="schedule-duration"]')?.textContent,
      ).toBe("About 45s – 3.4 hr.");
    });

    it(`draws the line even with no estimate — ${name}`, async () => {
      const { container } = mount(body, { firedOnce, durationCopy: null });
      await waitFor(() => expect(rows(container)).not.toBeNull());
      expect(container.textContent).toContain("Estimated run duration");
      expect(
        container.querySelector('[data-conformance-id="schedule-duration"]')?.textContent,
      ).toBe(DURATION_LINE_NO_ESTIMATE);
    });
  }
});

describe("no summary box stands between the reader and the form", () => {
  it("the card draws the rows and the floor, and no list or summary node at all", async () => {
    const { container } = mount(settled({}), { durationCopy: "About 45s – 3.4 hr." });
    await waitFor(() => expect(rows(container)).not.toBeNull());
    const card = container.querySelector('[data-conformance-id="schedule-proposal-card"]');
    expect(card).not.toBeNull();
    expect(card!.querySelectorAll("ul, ol, dl, table")).toHaveLength(0);
    expect(
      card!.querySelectorAll('[data-conformance-id*="summary"], [data-conformance-id*="status"]'),
    ).toHaveLength(0);
    // The rows own the card: nothing is drawn above them inside it.
    expect(card!.textContent?.trimStart().startsWith("When should this run?")).toBe(true);
  });
});
