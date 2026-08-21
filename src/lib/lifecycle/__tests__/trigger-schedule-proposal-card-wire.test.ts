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
  isAdmin: false,
};

/**
 * The settled schema EXACTLY as it stood before #2859 — copied field for field
 * off `triggerScheduleProposalSettledViewSchema` with the `superseded` entry
 * removed, and `.strict()` kept. This is the parser a stale client bundle is
 * still running; nothing here may be relaxed to make a test pass, because
 * relaxing it is precisely what the shipped bundle cannot do.
 */
const preSupersededSettledViewSchema = z
  .object({
    phase: z.literal("settled"),
    version: z.literal(TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION),
    agentName: z.string().min(1).max(200),
    runId: z.string().min(1).max(128),
    triggerType: z.enum(["immediate", "scheduled", "recurring"]),
    scheduleCopy: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64),
    gatedSteps: z.array(gatedStepViewSchema).max(50),
    released: z.boolean(),
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
    released: false,
    arming: false,
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
      gatedSteps: [],
      released: false,
      arming: false,
      canCancel: true,
      canRelease: false,
    });
  });

  it("PARSES under the pre-#2859 strict settled schema", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { view } = await resolveTriggerScheduleProposalCard(READER);

    // THE PIN. A client bundle that has not reloaded since #2859 landed runs
    // this exact parser. If the producer ever ships the key unconditionally,
    // every settled proposal card disappears for that reader — not just the
    // superseded ones — and this goes red.
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

  it("holds for an ADMIN reader too — the emission does not vary by standing", async () => {
    resolveProposalForReader.mockResolvedValue(settledResolution(false));

    const { view } = await resolveTriggerScheduleProposalCard({
      ...READER,
      isAdmin: true,
    });

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
