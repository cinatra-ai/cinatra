/**
 * The settled proposal card's WIRE EMISSION (cinatra#2859 / PR #2874 review).
 *
 * #2859 added `superseded` to the settled body. The schema made it OPTIONAL,
 * which is the right shape but only buys one direction: a NEW parser accepting
 * an OLD payload. The direction that actually breaks is the other one — a
 * client bundle still running the PRE-#2859 `.strict()` settled schema, which
 * rejects any payload carrying the unknown key. Under an unconditional
 * `superseded: resolved.superseded` that is EVERY settled card for that client,
 * not just the superseded ones, because the ordinary card would still ship
 * `superseded: false` to say it is not in the new state at all.
 *
 * So the producer OMITS the key unless it is true, and this suite is the pin on
 * that. The stale client is modelled the only way it can be from inside the
 * repo: by reconstructing the pre-change settled schema — the same object,
 * `.strict()`, WITHOUT the new field — and parsing the emitted body against it.
 *
 * The resolver behind the card is mocked. What is under test is the literal the
 * card producer emits, not the supersession comparison; that comparison is
 * pinned whole in `trigger-schedule-proposal-adjust-lineage.test.ts`, where
 * `ProposalResolution.superseded` stays an always-boolean.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

import {
  TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  gatedStepViewSchema,
  proposedScheduleSchema,
  triggerScheduleProposalSettledViewSchema,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

const resolveProposalForReader = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  describeProposalSchedule: () => "Every weekday at 09:00",
}));

import { resolveTriggerScheduleProposalCard } from "../trigger-schedule-proposal-card";

const READER = {
  ref: "ref-opaque",
  userId: "u1",
  orgId: "o1",
};

/**
 * The settled schema WITHOUT `superseded`, at the CURRENT body shape — copied
 * field for field off `triggerScheduleProposalSettledViewSchema` with that one
 * entry removed and `.strict()` kept. Nothing here may be relaxed to make a
 * test pass: `.strict()` is the whole property.
 *
 * WHAT MOVED, AND WHY IT IS NOT A WEAKENING (cinatra#2788, S9d). This schema
 * used to be "the settled schema exactly as it stood before #2859", modelling a
 * client bundle that had not reloaded since. S9d's plan text adds two REQUIRED
 * fields to the settled body — `schedule` (the armed selections, because the
 * settled card now draws the same option rows: plan (A) §7.2, "the same card,
 * with the same option rows, now shows the armed schedule") and `canSave` (its
 * Save-changes floor). There is no way to draw those rows without sending them,
 * so a pre-S9d strict parser cannot read a post-S9d settled body, and pinning
 * that it can would be pinning a promise the plan already broke.
 *
 * The pin that is worth keeping is the one this file was written for, and it is
 * kept intact: an ORDINARY settled card carries no `superseded` key at all, so a
 * parser that does not know the key still reads it. What changed is which
 * baseline that parser is at — S9d's, because S9d's is the first shape this card
 * ever reaches a browser in: on `main` the schedule kind dispatches the
 * placeholder shell, so no deployed bundle parses a settled body at all.
 */
const preSupersededSettledViewSchema = z
  .object({
    phase: z.literal("settled"),
    version: z.literal(TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION),
    agentName: z.string().min(1).max(200),
    runId: z.string().min(1).max(128),
    schedule: proposedScheduleSchema,
    triggerType: z.enum(["immediate", "scheduled", "recurring"]),
    scheduleCopy: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64),
    gatedSteps: z.array(gatedStepViewSchema).max(50),
    released: z.boolean(),
    canSave: z.boolean(),
    canCancel: z.boolean(),
    canRelease: z.boolean(),
    arming: z.boolean(),
  })
  .strict();

function settledResolution(superseded: boolean) {
  return {
    phase: "settled" as const,
    runId: "run_1",
    agentName: "Weekly digest",
    triggerType: "recurring" as const,
    scheduleCopy: superseded
      ? "This card was adjusted before it was set — open the run to see the schedule that was set."
      : "Every weekday at 09:00",
    timezone: "Europe/Berlin",
    schedule: {
      kind: "recurring" as const,
      timezone: "Europe/Berlin",
      selection: {
        frequency: "weekly" as const,
        interval: 1,
        weekdays: [1, 2, 3, 4, 5],
        dayOfMonth: 1,
        monthlyMode: "date" as const,
        nthWeek: 1 as const,
        monthlyWeekday: 1,
        quarterAnchor: "start" as const,
        yearlyMonth: 1,
        hour: 9,
        minute: 0,
      },
    },
    released: false,
    arming: false,
    // cinatra#2972 — the two readings the settled resolution gained. This
    // fixture is a recurring schedule that has NOT fired yet, so it carries no
    // **Cancel schedule** ("shown only for a recurring schedule that has fired
    // once", plan (A) §7.2 amended 2026-08-25) and has been stopped by nobody.
    firedOnce: false,
    stopped: false,
    canSave: true,
    superseded,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an ordinary settled card is byte-compatible with a stale client", () => {
  it("emits NO `superseded` key at all", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { state, view } = await resolveTriggerScheduleProposalCard(READER);

    expect(state).toEqual({ state: "settled" });
    expect(view).not.toBeNull();
    // Not `toBe(false)`, not `toBeUndefined()` — the key must be ABSENT, which
    // is the only thing a `.strict()` parser on the other side can accept.
    expect("superseded" in (view as object)).toBe(false);
    // Whole-object, so a re-added `superseded: false` fails here too.
    expect(view).toEqual({
      phase: "settled",
      version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
      agentName: "Weekly digest",
      runId: "run_1",
      triggerType: "recurring",
      scheduleCopy: "Every weekday at 09:00",
      timezone: "Europe/Berlin",
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
          monthlyWeekday: 1,
          quarterAnchor: "start",
          yearlyMonth: 1,
          hour: 9,
          minute: 0,
        },
      },
      gatedSteps: [],
      released: false,
      arming: false,
      canSave: true,
      // cinatra#2972 — Cancel schedule is the recurring schedule's control
      // AFTER its first fire, and this fixture has not fired.
      canCancel: false,
      // `canRelease` is still EMITTED as a constant false — a compatibility
      // shim for a stale bundle whose strict settled schema still requires the
      // key. The control it once gated is gone; nothing reads this.
      canRelease: false,
    });
  });

  it("PARSES under a strict settled schema that does not know `superseded`", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    // THE PIN. A parser that does not know `superseded` runs this exact schema.
    // If the producer ever ships the key unconditionally, every settled proposal
    // card disappears for that reader — not just the superseded ones — and this
    // goes red.
    const parsed = preSupersededSettledViewSchema.safeParse(view);
    expect(parsed.success).toBe(true);
  });

  it("still parses under the NEW schema — the omission is not a widening", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    expect(triggerScheduleProposalSettledViewSchema.safeParse(view).success).toBe(
      true,
    );
  });

  // cinatra#2972 retired the card's one admin-varying reading (`canRelease`, the
  // Run now the plan withdrew), so the resolver no longer takes an `isAdmin` at
  // all. The pin stays as "the emission does not vary" — there is now nothing
  // left for it to vary by, which is the stronger statement.
  it("does not vary by the reader's standing — nothing on this card reads one", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    expect("superseded" in (view as object)).toBe(false);
    expect(preSupersededSettledViewSchema.safeParse(view).success).toBe(true);
  });
});

describe("a genuinely superseded card carries the flag", () => {
  it("emits `superseded: true` and parses under the NEW schema", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(true));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    expect(view).toMatchObject({ phase: "settled", superseded: true });
    expect(triggerScheduleProposalSettledViewSchema.safeParse(view).success).toBe(
      true,
    );
  });

  it("is the ONE card a stale client loses — the honest blast radius", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(true));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    // Stated as a test rather than only in a comment: the rare, NEW state is
    // where the incompatibility is spent, and it is spent on a card whose whole
    // point is that it no longer describes what was installed.
    expect(preSupersededSettledViewSchema.safeParse(view).success).toBe(false);
  });
});

describe("the pending card is untouched by any of this", () => {
  it("carries no `superseded` key either", async () => {
    resolveProposalForReader.mockResolvedValue({
      phase: "proposal",
      proposal: {
        schedule: {
          mode: "recurring",
          recurring: { preset: "weekdays", timeOfDay: "09:00" },
        },
      },
      agentName: "Weekly digest",
      canConfirm: true,
      restrictedReason: null,
    });

    const { state, view } = await resolveTriggerScheduleProposalCard(READER);

    expect(state).toEqual({ state: "pending", canDecide: true, canComment: false });
    expect("superseded" in (view as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE DURABLE FIRED SIGNAL ON THE WIRE (cinatra#3174, criterion 4).
// ---------------------------------------------------------------------------
// The card's own section names "Fired, recurring - runs still to come" as a
// reading of its own, and nothing else on the settled body can tell it from
// "Configured" once the schedule has been stopped: `canCancel` goes false the
// moment **Cancel schedule** is pressed, so a stopped-after-firing card and a
// never-fired one answered identically.
//
// The producer therefore forwards the resolver's OWN `firedOnce` - the trigger
// row's `lastFiredAt` for a recurring schedule, its `releasedAt` for a one-off,
// already read server-side for the floor - and forwards it under exactly the
// rule `superseded` is under: OMITTED unless true, because this schema is
// `.strict()` and a client on an older bundle would otherwise reject EVERY
// settled payload rather than only the fired ones.
//
// This is the producer half. That the CARD then reads the key into one of the
// section's five readings is pinned in
// `packages/agents/src/__tests__/schedule-card-reported-reading-3174.test.tsx`,
// which mounts the real card; what is pinned HERE is that the key the card
// reads is a key the resolver actually emits.
// ---------------------------------------------------------------------------

describe("cinatra#3174 - the fired signal reaches the card", () => {
  it("emits `firedOnce: true` when the resolver says the schedule has fired", async () => {
    resolveProposalForReader.mockResolvedValue({
      ...settledResolution(false),
      firedOnce: true,
    });

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    expect(view).not.toBeNull();
    expect((view as Record<string, unknown>).firedOnce).toBe(true);
    // And it is a body the SHIPPED schema accepts, not a loose object.
    expect(() => triggerScheduleProposalSettledViewSchema.parse(view)).not.toThrow();
  });

  it("emits NO `firedOnce` key for a schedule that has not fired", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    // ABSENT, not `false` - the same rule `superseded` is under, and the only
    // shape a `.strict()` parser that predates the key can accept.
    expect("firedOnce" in (view as object)).toBe(false);
    expect(() => preSupersededSettledViewSchema.parse(view)).not.toThrow();
  });

  it("keeps the fired body readable by the shipped parser AND unreadable by the older one", async () => {
    resolveProposalForReader.mockResolvedValue({
      ...settledResolution(false),
      firedOnce: true,
    });

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    // The point of the omission rule, stated both ways round: only a card that
    // has actually fired is out of reach of a bundle that predates the key.
    expect(() => triggerScheduleProposalSettledViewSchema.parse(view)).not.toThrow();
    expect(() => preSupersededSettledViewSchema.parse(view)).toThrow();
  });
});
