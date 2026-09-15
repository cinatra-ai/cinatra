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
// The seam an older bundle reads the answer with, and the one this bundle reads
// a version-1 answer with (cinatra#3193).
import { parseLifecycleResolveEnvelope } from "@cinatra-ai/agent-ui-protocol/renderable-views";

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
// THE DURABLE FIRED SIGNAL, BESIDE THE BODY (cinatra#3174, criterion 4; put on
// this road by cinatra#3193).
// ---------------------------------------------------------------------------
// The card's own section names "Fired, recurring - runs still to come" as a
// reading of its own, and nothing else on the settled body can tell it from
// "Configured" once the schedule has been stopped: `canCancel` goes false the
// moment **Cancel schedule** is pressed, so a stopped-after-firing card and a
// never-fired one answered identically.
//
// IT DOES NOT TRAVEL INSIDE THE BODY, AND THAT IS THE POINT OF THIS BLOCK.
// #3174 first shipped it as a new optional key on the settled body under the
// rule `superseded` is under - omitted unless true - and pinned, here, that a
// version-1 parser therefore REFUSED a fired body. That pin was the defect. The
// omission compromise is only honest where the new state is RARE: it trades a
// blank card in a corner for a readable card everywhere else. A schedule that
// has fired is not a corner - every recurring schedule that has ever run is in
// it - so the trade would have blanked the common case on every bundle that had
// not reloaded.
//
// And there is no version to bump into either: `version` is a `z.literal`, so a
// bump makes a shipped parser refuse every card of every state at once.
//
// So the reading rides the resolve ANSWER, beside the body, which is the one
// part of that answer a parser reads by name while ignoring what it does not
// know (`parseLifecycleResolveEnvelope`). What this block pins is the property
// that buys: BOTH directions read, with `.strict()` untouched on both schemas.
//
// This is the producer half. That the CARD then reads the aside into one of the
// section's five readings is pinned in
// `packages/agents/src/__tests__/schedule-card-reported-reading-3174.test.tsx`,
// which mounts the real card.
// ---------------------------------------------------------------------------

/** A settled body exactly as a version-1 SERVER would have emitted it - the
 *  fields the pre-#2859 schema declares and nothing else. Used to prove the
 *  other direction: this bundle's parser still reads what an older one sends. */
const VERSION_ONE_SETTLED_BODY = {
  phase: "settled",
  version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  agentName: "Weekly digest",
  runId: "run_1",
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
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 09:00",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  canSave: true,
  canCancel: false,
  canRelease: false,
  arming: false,
};

describe("cinatra#3174 - the fired signal reaches the card, on the answer", () => {
  it("answers `firedOnce` beside the body, and puts NO such key in the body", async () => {
    resolveProposalForReader.mockResolvedValue({
      ...settledResolution(false),
      firedOnce: true,
    });

    const card = await resolveTriggerScheduleProposalCard(READER);

    // The reading is the resolver's, whole, and it reaches the card.
    expect(card.firedOnce).toBe(true);
    // And it is NOT in the body. Not `false`, not `undefined` - absent, which
    // is the only shape a `.strict()` version-1 parser can accept.
    expect("firedOnce" in (card.view as object)).toBe(false);
  });

  it("answers `firedOnce: false` for a schedule that has not fired", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const card = await resolveTriggerScheduleProposalCard(READER);

    expect(card.firedOnce).toBe(false);
    expect("firedOnce" in (card.view as object)).toBe(false);
  });

  it("a version-1 parser reads a FIRED card's body, whole", async () => {
    resolveProposalForReader.mockResolvedValue({
      ...settledResolution(false),
      firedOnce: true,
    });

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    // THE PIN THIS BLOCK EXISTS FOR, and the one that used to say the
    // opposite. A bundle still running the shipped version-1 schema draws the
    // fired card exactly as it draws every other settled card. It cannot know
    // the schedule has fired - it has no reading for that - but it is not
    // blanked, which is the whole difference between a client that is behind
    // and a client that is broken.
    expect(preSupersededSettledViewSchema.safeParse(view).success).toBe(true);
    // And the shipped parser reads the same body, so nothing was traded away
    // in the other direction to get it.
    expect(triggerScheduleProposalSettledViewSchema.safeParse(view).success).toBe(true);
  });

  it("a STOPPED-after-firing card adds NOTHING to what a version-1 parser refuses", async () => {
    // The reading `canCancel` cannot answer, and the one the fired signal was
    // added for: pressing **Cancel schedule** takes `canCancel` false again, so
    // a stopped-after-firing card and a never-fired one are indistinguishable
    // on the body alone.
    resolveProposalForReader.mockResolvedValue({
      ...settledResolution(false),
      firedOnce: true,
      stopped: true,
    });

    const card = await resolveTriggerScheduleProposalCard(READER);

    expect(card.firedOnce).toBe(true);
    // `stopped` is its own pre-existing omitted-unless-true key (cinatra#2972),
    // and a version-1 parser refuses it - that trade was made there, on a state
    // that is genuinely rare, and this change neither widens nor revisits it.
    // What is pinned here is that FIRING contributes no second such key: the
    // only thing on this body a version-1 parser does not declare is `stopped`.
    const bodyKeys = Object.keys(card.view as object);
    const v1Keys = new Set(Object.keys(preSupersededSettledViewSchema.shape));
    expect(bodyKeys.filter((key) => !v1Keys.has(key))).toEqual(["stopped"]);
  });

  it("this bundle's parser reads a VERSION-1 body, and reads it as not fired", () => {
    // The other direction, and the reason the aside is read tolerantly rather
    // than required: an answer from a server that predates the reading carries
    // no such key at all, and must draw rather than refuse.
    const parsed = triggerScheduleProposalSettledViewSchema.safeParse(
      VERSION_ONE_SETTLED_BODY,
    );
    expect(parsed.success).toBe(true);

    const answer = parseLifecycleResolveEnvelope("trigger_schedule_proposal", {
      kind: "trigger_schedule_proposal",
      state: { state: "settled" },
      body: VERSION_ONE_SETTLED_BODY,
    });
    expect(answer).not.toBeNull();
    // `durationCopy` joined the aside in cinatra#3174 fix leg 1, on the same
    // seam and for the same reason: the settled body is `.strict()` and
    // version-1, so the estimated-duration line cannot be a key in it either.
    // An answer that carries neither reads as "not fired, no estimate".
    expect(answer?.aside).toEqual({ firedOnce: false, durationCopy: null });
  });

  it("the answer's aside is what carries the reading across the seam", async () => {
    resolveProposalForReader.mockResolvedValue({
      ...settledResolution(false),
      firedOnce: true,
    });

    const card = await resolveTriggerScheduleProposalCard(READER);
    // The shape the route sends: omitted unless true, beside the body.
    const answer = parseLifecycleResolveEnvelope("trigger_schedule_proposal", {
      kind: "trigger_schedule_proposal",
      state: card.state,
      body: card.view,
      ...(card.firedOnce ? { firedOnce: true } : {}),
    });
    expect(answer?.aside).toEqual({ firedOnce: true, durationCopy: null });
    expect(answer?.body).toEqual(card.view);
  });

  it("neither schema was relaxed to buy any of this", () => {
    // `.strict()` is the whole property on both sides, so both still refuse a
    // key they do not declare. If either had been widened, the compatibility
    // proved above would be worth nothing.
    const withUnknownKey = { ...VERSION_ONE_SETTLED_BODY, firedOnce: true };
    expect(preSupersededSettledViewSchema.safeParse(withUnknownKey).success).toBe(false);
    expect(triggerScheduleProposalSettledViewSchema.safeParse(withUnknownKey).success).toBe(
      false,
    );
  });
});
