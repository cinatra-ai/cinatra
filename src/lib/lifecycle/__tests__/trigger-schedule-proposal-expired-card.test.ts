/**
 * The EXPIRED proposal CARD — what the resolve endpoint hands a reader.
 *
 * Design: `specs/app-lifecycle-cards.html` §VI (the proposal card), §IV (the
 * state ladder, and what the undrawn state is reserved for).
 *
 * Two things are pinned here, and they are the two halves of the same rule:
 *
 *   DRAWN   — a reader whose own proposal timed out gets a card with a body
 *             that says so, on a state that promises no floor. Never `absent`,
 *             which draws no DOM at all and would delete the card, and the
 *             question it asked, out of their transcript.
 *   UNDRAWN — everyone else gets `absent` with no body, exactly as before.
 *             `absent` is §IV's answer for a reader who may not see the
 *             SUBJECT, and nothing here widens what reaches them.
 *
 * The resolution is stubbed: what this file is about is the MAPPING from a
 * resolution to the card's state + body. That the right resolution is reached
 * in the first place is proven against the real token in
 * `packages/agents/src/__tests__/trigger-schedule-proposal-expired.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { triggerScheduleProposalViewBodySchema } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import type { ProposalSchedule } from "@/lib/trigger-schedule-proposal-token";

const resolveProposalForReader = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForReader: (...args: unknown[]) => resolveProposalForReader(...args),
  describeProposalSchedule: () => "Every weekday at 9:00 AM",
}));

const { resolveTriggerScheduleProposalCard, ABSENT_PROPOSAL_CARD } = await import(
  "../trigger-schedule-proposal-card"
);

const WEEKDAYS_9AM: ProposalSchedule = {
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 0,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  },
};

const READER = {
  ref: "an-opaque-proposal-ref",
  userId: "user_2836",
  orgId: "org_2836",
  isAdmin: false,
};

const EXPIRED_RESOLUTION = {
  phase: "expired" as const,
  proposal: {
    templateId: "template-2836",
    userId: READER.userId,
    orgId: READER.orgId,
    schedule: WEEKDAYS_9AM,
    nonce: "nonce-2836",
    expiresAt: 1,
  },
  agentName: "Weekly digest",
  scheduleCopy: "Every weekday at 9:00 AM",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an expired proposal is DRAWN", () => {
  it("resolves to a card with a body, not to the empty answer", async () => {
    resolveProposalForReader.mockResolvedValue(EXPIRED_RESOLUTION);
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card.state.state).not.toBe("absent");
    expect(card.view).not.toBeNull();
    expect(card.view?.phase).toBe("expired");
  });

  it("draws it on the ladder's terminal rung — a reading with no floor to press", async () => {
    // `settled` is S1's "no longer open — nothing here for you to decide",
    // which is exactly an expired proposal's standing, and the same rung the
    // review card draws its own §IV "no longer open" on. The per-kind BODY
    // says which of the two terminal readings this is; the ladder stays one
    // ladder across all four interaction kinds.
    resolveProposalForReader.mockResolvedValue(EXPIRED_RESOLUTION);
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card.state).toEqual({ state: "settled" });
    // No decision affordance can be read off it, by construction.
    expect(card.state).not.toHaveProperty("canDecide");
  });

  it("carries a body that validates against the published view schema", async () => {
    resolveProposalForReader.mockResolvedValue(EXPIRED_RESOLUTION);
    const card = await resolveTriggerScheduleProposalCard(READER);
    const parsed = triggerScheduleProposalViewBodySchema.safeParse(card.view);
    expect(parsed.success).toBe(true);
  });

  it("says WHAT expired — the agent, and the schedule in the reader's own words", async () => {
    resolveProposalForReader.mockResolvedValue(EXPIRED_RESOLUTION);
    const card = await resolveTriggerScheduleProposalCard(READER);
    if (card.view?.phase !== "expired") throw new Error("expected an expired body");
    expect(card.view.agentName).toBe("Weekly digest");
    expect(card.view.scheduleCopy).toBe("Every weekday at 9:00 AM");
    // The selections ride along so Adjust re-opens the rows the reader saw.
    expect(card.view.schedule).toEqual(WEEKDAYS_9AM);
  });

  it("resolves the same way every time the conversation is reopened", async () => {
    // Reload persistence. The card refetches on mount, on focus and on reload;
    // an expired reading is derived from the ref alone, so it never decays into
    // the blank card this issue is about.
    resolveProposalForReader.mockResolvedValue(EXPIRED_RESOLUTION);
    const first = await resolveTriggerScheduleProposalCard(READER);
    const second = await resolveTriggerScheduleProposalCard(READER);
    const third = await resolveTriggerScheduleProposalCard(READER);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(third.view?.phase).toBe("expired");
  });

  it("names no identifier the transcript did not already entitle its reader to", async () => {
    resolveProposalForReader.mockResolvedValue(EXPIRED_RESOLUTION);
    const card = await resolveTriggerScheduleProposalCard(READER);
    const serialized = JSON.stringify(card);
    // The template id is the resolver's own business: Adjust travels the ref.
    expect(serialized).not.toContain("template-2836");
    expect(serialized).not.toContain("nonce-2836");
  });
});

describe("the reader who may not see the subject still sees NOTHING", () => {
  it("answers the one empty card for `absent`, body and all", async () => {
    resolveProposalForReader.mockResolvedValue({ phase: "absent" });
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card).toEqual(ABSENT_PROPOSAL_CARD);
    expect(card.state).toEqual({ state: "absent" });
    expect(card.view).toBeNull();
  });

  it("answers `absent` with no session identity to bind against", async () => {
    for (const missing of [
      { ...READER, userId: "" },
      { ...READER, orgId: "" },
    ]) {
      const card = await resolveTriggerScheduleProposalCard(missing);
      expect(card).toEqual(ABSENT_PROPOSAL_CARD);
    }
    // The resolution is never even reached — there is nothing to resolve for.
    expect(resolveProposalForReader).not.toHaveBeenCalled();
  });

  it("answers `absent` when the resolution throws, so a store fault is not an existence signal", async () => {
    resolveProposalForReader.mockRejectedValue(new Error("the store is down"));
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card).toEqual(ABSENT_PROPOSAL_CARD);
  });
});

describe("the readings that already worked are untouched", () => {
  it("keeps a live proposal on the pending rung with its floor", async () => {
    resolveProposalForReader.mockResolvedValue({
      phase: "proposal",
      proposal: EXPIRED_RESOLUTION.proposal,
      agentName: "Weekly digest",
      canConfirm: true,
      restrictedReason: null,
    });
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card.state).toEqual({ state: "pending", canDecide: true, canComment: false });
    expect(card.view?.phase).toBe("proposal");
  });

  it("keeps a reader who may see but not confirm on `restricted`, never on `absent`", async () => {
    resolveProposalForReader.mockResolvedValue({
      phase: "proposal",
      proposal: EXPIRED_RESOLUTION.proposal,
      agentName: "Weekly digest",
      canConfirm: false,
      restrictedReason: "This agent can't be run right now.",
    });
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card.state.state).toBe("restricted");
    expect(card.view?.phase).toBe("proposal");
  });

  it("keeps a confirmed proposal drawing the trigger's chrome", async () => {
    resolveProposalForReader.mockResolvedValue({
      phase: "settled",
      runId: "run_2836",
      agentName: "Weekly digest",
      triggerType: "recurring",
      scheduleCopy: "Every weekday at 9:00 AM",
      timezone: "Europe/Berlin",
      released: false,
      arming: false,
    });
    const card = await resolveTriggerScheduleProposalCard(READER);
    expect(card.state).toEqual({ state: "settled" });
    expect(card.view?.phase).toBe("settled");
  });
});
