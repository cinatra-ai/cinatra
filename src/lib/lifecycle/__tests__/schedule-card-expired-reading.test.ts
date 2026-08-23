/**
 * THE CARD RESOLVER DRAWS THE EXPIRED READING (cinatra#2836, epic #2784).
 *
 * Plan: `PLAN: Agents Lifecycle (A)` §7.2 step 2 — "an expired card **stays
 * visible**, still editable, with **Confirm** to set the schedule again";
 * §9.1 row 8. Design `app-lifecycle-cards.html` §IV: the undrawn answer is for a
 * reader who may not see the subject AT ALL.
 *
 * WHAT WAS WRONG. `resolveTriggerScheduleProposalCard` collapsed an expired
 * token into `absent` together with every forged and foreign one, and an
 * `absent` card draws no DOM at all — so thirty minutes after a person stated a
 * schedule, the card and the question it asked vanished out of their own
 * transcript with no trace and no way to state it again.
 *
 * WHAT THIS FILE PINS.
 *
 *   1. An expired phase becomes a DRAWN card: the `expired` body, with the rows
 *      the reader stated and the plain-words line, over a PRESSABLE floor.
 *   2. `absent` is still the answer for everyone else, and the refusal for an
 *      expired-foreign ref is byte-identical to the one for a forged ref — at
 *      the card, which is the layer a surface can actually observe.
 *   3. The Confirm press on that card reaches the re-propose path, and reaches
 *      the LIVE path when the card is live. Neither can be entered with a ref the
 *      reader does not own.
 *
 * Seam tier: the service is mocked HERE — this file is about the mapping from a
 * resolution to a state, a body and an op. That an expired token actually
 * PRODUCES the expired resolution, over real crypto, is
 * `packages/agents/src/__tests__/trigger-schedule-proposal-expired-repropose.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveProposalForRun = vi.fn();
const resolveProposalForReader = vi.fn();
const adjustTriggerSchedule = vi.fn();
const reproposeExpiredSchedule = vi.fn();
const confirmTriggerScheduleProposal = vi.fn();

// The service's own refusal copy, INLINE in the factory: `vi.mock` is hoisted
// above every top-level binding, so a factory that closed over a `const`
// declared here would read it before initialization.
vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: (...a: unknown[]) => resolveProposalForRun(...a),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  adjustTriggerSchedule: (...a: unknown[]) => adjustTriggerSchedule(...a),
  reproposeExpiredSchedule: (...a: unknown[]) => reproposeExpiredSchedule(...a),
  confirmTriggerScheduleProposal: (...a: unknown[]) =>
    confirmTriggerScheduleProposal(...a),
  describeProposalSchedule: () => "Every weekday at 9:00 AM",
  PROPOSAL_REFUSALS: {
    invalid:
      "This schedule is no longer valid — it may have expired. Ask again and confirm the new card.",
    notRunnable:
      "This agent can't be run right now. Open its listing to see what it needs.",
  },
}));

/** The same copy the factory serves, for the assertions to read back against. */
const PROPOSAL_REFUSALS = {
  invalid:
    "This schedule is no longer valid — it may have expired. Ask again and confirm the new card.",
  notRunnable:
    "This agent can't be run right now. Open its listing to see what it needs.",
} as const;

import {
  ABSENT_PROPOSAL_CARD,
  SCHEDULE_DECISION_REFUSAL,
  decideTriggerScheduleProposal,
  resolveTriggerScheduleProposalCard,
} from "../trigger-schedule-proposal-card";

const READER = { userId: "u-1", orgId: "org-1", isAdmin: false };
const REF = "a-proposal-ref";

const RECURRING = {
  kind: "recurring" as const,
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly" as const,
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date" as const,
    nthWeek: 1 as const,
    monthlyWeekday: 0,
    quarterAnchor: "start" as const,
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  },
};

/** What the service answers for a reader's own expired proposal. */
function expiredResolution(over: Record<string, unknown> = {}) {
  return {
    phase: "expired",
    proposal: {
      templateId: "tpl-1",
      userId: "u-1",
      orgId: "org-1",
      schedule: RECURRING,
      nonce: "n-1",
      expiresAt: 1,
    },
    agentName: "Weekly digest",
    canConfirm: true,
    restrictedReason: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProposalForReader.mockResolvedValue({ phase: "absent" });
  resolveProposalForRun.mockResolvedValue({ phase: "absent" });
});

// ---------------------------------------------------------------------------
// THE DRAWN READING
// ---------------------------------------------------------------------------

describe("an expired proposal is DRAWN, not deleted", () => {
  it("answers the `expired` body over a PRESSABLE floor", async () => {
    resolveProposalForReader.mockResolvedValue(expiredResolution());

    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });

    // The floor is pressable — the press re-proposes and confirms the
    // replacement, so `pending` is the honest rung, exactly as on a live card.
    expect(card.state).toEqual({ state: "pending", canDecide: true, canComment: false });
    expect(card.view).toEqual({
      phase: "expired",
      version: 1,
      agentName: "Weekly digest",
      // The rows the reader last saw — the card re-opens on their own schedule.
      schedule: RECURRING,
      // Worded by the ONE renderer the settled card reads back through.
      scheduleCopy: "Every weekday at 9:00 AM",
    });
  });

  it("is emphatically NOT absent — the card has DOM to draw", async () => {
    resolveProposalForReader.mockResolvedValue(expiredResolution());
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(card.state.state).not.toBe("absent");
    expect(card.view).not.toBeNull();
  });

  it("carries the reader's own restriction when the agent cannot be run", async () => {
    resolveProposalForReader.mockResolvedValue(
      expiredResolution({ canConfirm: false, restrictedReason: PROPOSAL_REFUSALS.notRunnable }),
    );

    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });

    // §IV: a reader who may SEE but not act gets a DRAWN card with the reason,
    // never a silently dropped one.
    expect(card.state).toEqual({
      state: "restricted",
      canDecide: false,
      canComment: false,
      reason: PROPOSAL_REFUSALS.notRunnable,
    });
    expect(card.view).not.toBeNull();
    expect(card.view?.phase).toBe("expired");
  });

  it("the expired body carries no floor flags and no run — there is nothing armed", async () => {
    resolveProposalForReader.mockResolvedValue(expiredResolution());
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(Object.keys(card.view ?? {}).sort()).toEqual([
      "agentName",
      "phase",
      "schedule",
      "scheduleCopy",
      "version",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AND STILL NO ORACLE
// ---------------------------------------------------------------------------

describe("the refusal for everyone else is unchanged, byte for byte", () => {
  it("an absent resolution still answers the one absent card, with no body", async () => {
    resolveProposalForReader.mockResolvedValue({ phase: "absent" });
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(card).toEqual(ABSENT_PROPOSAL_CARD);
    expect(card.view).toBeNull();
  });

  it("expired-foreign and forged reach the card as the SAME answer", async () => {
    // Both arrive here as the service's one `absent`, because the token layer
    // refuses them identically — so the card cannot separate them either.
    const answers: string[] = [];
    for (const _ of ["expired-foreign", "forged", "garbage"]) {
      resolveProposalForReader.mockResolvedValue({ phase: "absent" });
      const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
      answers.push(JSON.stringify({ state: card.state, body: card.view }));
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe('{"state":{"state":"absent"},"body":null}');
  });

  it("a reader with no user or no org never even reaches the service", async () => {
    for (const who of [
      { userId: "", orgId: "org-1", isAdmin: false },
      { userId: "u-1", orgId: "", isAdmin: false },
    ]) {
      expect(await resolveTriggerScheduleProposalCard({ ref: REF, ...who })).toEqual(
        ABSENT_PROPOSAL_CARD,
      );
    }
    expect(resolveProposalForReader).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE PRESS
// ---------------------------------------------------------------------------

describe("Confirm on the expired card reaches the re-propose path", () => {
  it("routes an EXPIRED prior to `reproposeExpiredSchedule`, never to the live Adjust", async () => {
    resolveProposalForReader.mockResolvedValue(expiredResolution());
    reproposeExpiredSchedule.mockResolvedValue({ ok: true, token: "fresh-ref", expiresAt: 42 });

    const outcome = await decideTriggerScheduleProposal({
      ref: REF,
      op: "adjust",
      schedule: RECURRING,
      userId: "u-1",
      orgId: "org-1",
      role: null,
    });

    expect(outcome).toEqual({ kind: "reproposed", ref: "fresh-ref", expiresAt: 42 });
    expect(reproposeExpiredSchedule).toHaveBeenCalledWith({
      // THE SUBJECT COMES FROM THE REF THE CARD WAS DRAWN WITH, never the body.
      priorToken: REF,
      userId: "u-1",
      orgId: "org-1",
      schedule: RECURRING,
    });
    expect(adjustTriggerSchedule).not.toHaveBeenCalled();
  });

  it("routes a LIVE prior to the live Adjust, unchanged", async () => {
    resolveProposalForReader.mockResolvedValue({
      phase: "proposal",
      proposal: { schedule: RECURRING },
      agentName: "Weekly digest",
      canConfirm: true,
      restrictedReason: null,
    });
    adjustTriggerSchedule.mockResolvedValue({ ok: true, token: "fresh-ref", expiresAt: 42 });

    const outcome = await decideTriggerScheduleProposal({
      ref: REF,
      op: "adjust",
      schedule: RECURRING,
      userId: "u-1",
      orgId: "org-1",
      role: null,
    });

    expect(outcome).toEqual({ kind: "reproposed", ref: "fresh-ref", expiresAt: 42 });
    expect(adjustTriggerSchedule).toHaveBeenCalled();
    expect(reproposeExpiredSchedule).not.toHaveBeenCalled();
  });

  it("a ref the reader does not own is refused with the ONE sentence, and re-proposes nothing", async () => {
    resolveProposalForReader.mockResolvedValue({ phase: "absent" });

    const outcome = await decideTriggerScheduleProposal({
      ref: REF,
      op: "adjust",
      schedule: RECURRING,
      userId: "u-1",
      orgId: "org-1",
      role: null,
    });

    expect(outcome).toEqual({ kind: "not-permitted", message: SCHEDULE_DECISION_REFUSAL });
    expect(reproposeExpiredSchedule).not.toHaveBeenCalled();
    expect(adjustTriggerSchedule).not.toHaveBeenCalled();
  });

  it("a SETTLED card is not re-proposable — it has a run", async () => {
    resolveProposalForReader.mockResolvedValue({ phase: "settled", runId: "run-1" });

    const outcome = await decideTriggerScheduleProposal({
      ref: REF,
      op: "adjust",
      schedule: RECURRING,
      userId: "u-1",
      orgId: "org-1",
      role: null,
    });

    expect(outcome).toEqual({ kind: "not-permitted", message: SCHEDULE_DECISION_REFUSAL });
    expect(reproposeExpiredSchedule).not.toHaveBeenCalled();
  });

  it("rows the scheduling step could not have produced are refused before anything mints", async () => {
    resolveProposalForReader.mockResolvedValue(expiredResolution());

    const outcome = await decideTriggerScheduleProposal({
      ref: REF,
      op: "adjust",
      schedule: { kind: "recurring", timezone: "Europe/Berlin", cronExpression: "* * * * *" },
      userId: "u-1",
      orgId: "org-1",
      role: null,
    });

    expect(outcome).toEqual({ kind: "error", message: PROPOSAL_REFUSALS.invalid });
    expect(reproposeExpiredSchedule).not.toHaveBeenCalled();
  });

  it("a re-propose that refuses surfaces as state copy, never as a silent success", async () => {
    resolveProposalForReader.mockResolvedValue(expiredResolution());
    reproposeExpiredSchedule.mockResolvedValue({ ok: false });

    const outcome = await decideTriggerScheduleProposal({
      ref: REF,
      op: "adjust",
      schedule: RECURRING,
      userId: "u-1",
      orgId: "org-1",
      role: null,
    });

    expect(outcome).toEqual({ kind: "error", message: PROPOSAL_REFUSALS.invalid });
  });
});
