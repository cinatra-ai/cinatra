/**
 * THE HELD SCHEDULE'S CARD OPENS ON THE ROW THE DECISION NAMES (cinatra#2936,
 * epic #2926 W6).
 *
 * Plan (B) §3: the schedule moment is decided from "the coordinator's own
 * default … run right after setup unless a schedule was stated in the
 * conversation", and in a conversation "the carrier is the schedule the person
 * stated, held until Confirm". A held schedule IS that decision's `stated`
 * answer, so the card's rows come from the one decision — the same function the
 * run page's scheduling step reads — rather than from a rule of the resolver's
 * own.
 *
 * PINNED THROUGH THE DEPENDENCY, NOT THROUGH THE VALUE. For a stated schedule
 * the decision answers with that schedule unchanged, so a body that read the
 * token directly would produce identical rows. The decision is therefore
 * STUBBED here and made to answer something the token does not carry: what the
 * card draws has to be the answer, and a refusal has to be honoured as one.
 *
 * Seam tier: the service is mocked, exactly as the sibling expired-reading file
 * does — this is about the mapping from a resolution to a drawn body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveProposalForRun = vi.fn();
const resolveProposalForReader = vi.fn();
const scheduleScreenSelection = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: (...a: unknown[]) => resolveProposalForRun(...a),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  describeProposalSchedule: () => "Every weekday at 8:00 AM",
}));

// The decision itself, stubbed. Everything else on the registry stays real —
// the resolver reads schemas and constants from it too.
vi.mock("@cinatra-ai/agent-ui-protocol/renderable-views", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    scheduleScreenSelection: (...a: unknown[]) => scheduleScreenSelection(...a),
  };
});

import { resolveTriggerScheduleProposalCard } from "../trigger-schedule-proposal-card";

const READER = { userId: "u-1", orgId: "org-1" };
const REF = "a-proposal-ref";

/** What the token carries. */
const STATED = {
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
    hour: 8,
    minute: 0,
  },
};

/** What the DECISION answers — deliberately not what the token carries, so the
 *  drawn rows can only have come from the decision. */
const DECIDED = { kind: "immediate" as const };

function heldResolution(phase: "proposal" | "expired") {
  return {
    phase,
    proposal: {
      templateId: "tpl-1",
      userId: "u-1",
      orgId: "org-1",
      schedule: STATED,
      nonce: "n-1",
      expiresAt: 1,
    },
    agentName: "Weekly digest",
    canConfirm: true,
    restrictedReason: null,
  };
}

function drawnSchedule(view: unknown): unknown {
  return view && typeof view === "object" && "schedule" in view
    ? (view as { schedule: unknown }).schedule
    : null;
}

beforeEach(() => {
  resolveProposalForRun.mockReset();
  resolveProposalForReader.mockReset();
  scheduleScreenSelection.mockReset();
  scheduleScreenSelection.mockReturnValue(DECIDED);
});

describe("the rows a held schedule's card is drawn with", () => {
  it("are the decision's answer, asked for with the schedule the person stated", async () => {
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal"));
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(card.view?.phase).toBe("proposal");
    // The decision was asked, with both of its inputs: a person IS present for a
    // held schedule — the resolution above answers `absent` for every reader the
    // token was not minted for — and the stated schedule is the other input.
    expect(scheduleScreenSelection).toHaveBeenCalledWith({
      humanPresent: true,
      statedSchedule: STATED,
    });
    // And what is drawn is what it answered, not what the token carried.
    expect(drawnSchedule(card.view)).toEqual(DECIDED);
  });

  it("and the expired reading re-opens through the very same decision", async () => {
    resolveProposalForReader.mockResolvedValue(heldResolution("expired"));
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(card.view?.phase).toBe("expired");
    expect(scheduleScreenSelection).toHaveBeenCalledWith({
      humanPresent: true,
      statedSchedule: STATED,
    });
    expect(drawnSchedule(card.view)).toEqual(DECIDED);
  });

  it("a REFUSAL is honoured: no rows, no card — never an invented row", async () => {
    scheduleScreenSelection.mockReturnValue(null);
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal"));
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(card.state).toEqual({ state: "absent" });
    expect(card.view).toBeNull();
  });

  it("and the expired reading refuses the same way", async () => {
    scheduleScreenSelection.mockReturnValue(null);
    resolveProposalForReader.mockResolvedValue(heldResolution("expired"));
    const card = await resolveTriggerScheduleProposalCard({ ref: REF, ...READER });
    expect(card.state).toEqual({ state: "absent" });
    expect(card.view).toBeNull();
  });
});
