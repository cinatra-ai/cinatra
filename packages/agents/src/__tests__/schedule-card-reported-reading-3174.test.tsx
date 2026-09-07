// @vitest-environment jsdom
//
// THE CARD REPORTS WHICH OF THE FIVE READINGS IT IS IN (cinatra#3174,
// criterion 4).
//
// The drawing's own section for this card names five readings and no more —
// "One card, five readings, and never a second card" — and lists them: first
// shown (nothing exists yet), configured (the schedule as it stands), expired
// (nothing was scheduled), fired one-off (the schedule was spent), and fired
// recurring (runs still to come). Two of them differ in what the reader is
// told: "It is still recurring, so the rows below still take a change — it
// applies to the runs still to come" is the fired-recurring turn, and a
// recurring schedule that has never fired reads nothing like it.
//
// Until now the card could not tell those two apart at all. `canCancel` is the
// FLOOR's reading and goes false the moment the schedule is stopped, so a
// stopped-after-firing card and a never-fired one answered identically. The
// durable signal that does tell them apart already existed server-side —
// `firedOnce`, off the trigger row's own stamp — and this issue puts it on the
// wire and has the card report the reading it selects.
//
// IT RIDES THE ANSWER, BESIDE THE BODY (cinatra#3193). The settled body is a
// versioned `.strict()` object, so a new key in it blanks the card on every
// bundle still parsing the shipped schema — and a schedule that has fired is
// the common case, not a corner of it. The reading therefore travels as a
// sibling of the body on the resolve answer, which is the one part of that
// answer an older parser reads by name and ignores what it does not know. The
// fixtures below carry it exactly where the wire does.
//
// IT IS REPORTED, NOT DRAWN. The same section forbids the obvious alternative:
// "No summary box is ever drawn, no status label, and nothing stands between
// the reader and the form." So the reading rides a passive attribute on the
// card's own root — readable by a test and by a rendered reading of the
// screen, drawn as nothing — and the five readings stay exactly the five
// pictures the section draws.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-card-reported-reading-3174.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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
  ref: "reading-ref",
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
    runId: "run-3174",
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

/** One reading, as the resolve ANSWER carries it: the body, and the fired
 *  signal beside it (cinatra#3193). */
type Reading = { body: TriggerScheduleProposalViewBody; firedOnce?: boolean };

/** The five readings the section draws, as the answers the resolver produces. */
const BODIES: Record<string, Reading> = {
  // "First shown — nothing exists yet · editable · Confirm"
  firstShown: { body: {
    phase: "proposal",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule: RECURRING,
    durationCopy: "About 45s – 3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
  } },
  // "Expired — nothing was scheduled · editable · Confirm"
  expired: { body: {
    phase: "expired",
    version: 1,
    agentName: "Weekly cohort sweep",
    schedule: RECURRING,
    scheduleCopy: "Every weekday at 9:00 AM",
  } },
  // "Configured — the schedule as it stands · editable · Save changes"
  configured: { body: settled({ canSave: true, canCancel: false }) },
  // "Fired, one-off — the schedule was spent · read-only · none at all"
  firedOneOff: {
    body: settled({
      triggerType: "scheduled",
      schedule: ONE_OFF,
      scheduleCopy: "Once, at 2026-07-14 09:00",
      released: true,
      canSave: false,
      canCancel: false,
    }),
    firedOnce: true,
  },
  // "Fired, recurring — runs still to come · editable · Save changes ·
  //  Cancel schedule"
  firedRecurring: {
    body: settled({ canSave: true, canCancel: true }),
    firedOnce: true,
  },
  // The same recurring schedule after Cancel schedule was pressed. It HAS
  // fired, so it is the same reading — and it is the case that proves the
  // reading rides `firedOnce` rather than the floor's own `canCancel`.
  firedRecurringStopped: {
    body: settled({ stopped: true, canSave: false, canCancel: false }),
    firedOnce: true,
  },
};

function mount({ body, firedOnce }: Reading) {
  const state: LifecycleCardState =
    body.phase === "settled"
      ? { state: "settled" }
      : { state: "pending", canDecide: true, canComment: false };
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state,
          body,
          // OMITTED UNLESS TRUE, exactly as the route emits it.
          ...(firedOnce ? { firedOnce: true } : {}),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  ) as unknown as typeof fetch;
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function readingOf(reading: Reading): Promise<string | null> {
  const view = mount(reading);
  let card: Element | null = null;
  await waitFor(() => {
    card = view.container.querySelector('[data-conformance-id="schedule-proposal-card"]');
    expect(card).not.toBeNull();
  });
  return (card as unknown as Element).getAttribute("data-schedule-reading");
}

describe("the card reports which of the section's five readings it is in", () => {
  it("names each of the five, and names them apart", async () => {
    const seen: Record<string, string | null> = {};
    for (const [name, reading] of Object.entries(BODIES)) {
      seen[name] = await readingOf(reading);
      cleanup();
    }
    expect(seen.firstShown).toBe("first-shown");
    expect(seen.expired).toBe("expired");
    expect(seen.configured).toBe("configured");
    expect(seen.firedOneOff).toBe("fired-one-off");
    expect(seen.firedRecurring).toBe("fired-recurring");
    // Five readings, five answers — no two of the section's rows collapse.
    const distinct = new Set([
      seen.firstShown,
      seen.expired,
      seen.configured,
      seen.firedOneOff,
      seen.firedRecurring,
    ]);
    expect(distinct.size).toBe(5);
  });

  it("a recurring schedule that HAS fired never reads as one that has not", async () => {
    const fired = await readingOf(BODIES.firedRecurring);
    cleanup();
    const neverFired = await readingOf(BODIES.configured);
    expect(fired).toBe("fired-recurring");
    expect(neverFired).toBe("configured");
    expect(fired).not.toBe(neverFired);
  });

  it("reads off the durable fired signal, not off the floor's own control", async () => {
    // Cancel schedule was pressed, so `canCancel` is false and `canSave` is
    // false — the same two answers a never-fired recurring card gives for
    // `canCancel`. The schedule has still fired, and the reading says so.
    const stopped = await readingOf(BODIES.firedRecurringStopped);
    expect(stopped).toBe("fired-recurring");
  });

  it("reports the reading without DRAWING one — no status label over the rows", async () => {
    // "No summary box is ever drawn, no status label, and nothing stands
    // between the reader and the form."
    for (const reading of [BODIES.firedRecurring, BODIES.configured]) {
      const view = mount(reading);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-conformance-id="schedule-option-rows"]'),
        ).not.toBeNull(),
      );
      const text = view.container.textContent ?? "";
      for (const word of ["fired-recurring", "configured", "Fired", "Configured"]) {
        expect(text).not.toContain(word);
      }
      cleanup();
    }
  });
});
