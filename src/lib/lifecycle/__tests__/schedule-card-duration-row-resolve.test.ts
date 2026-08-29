/**
 * THE SCHEDULE CARD'S "ESTIMATED RUN DURATION" ROW IS FILLED (cinatra#2853, the
 * picture leg).
 *
 * Plan (A) §7.2: "Under them, Estimated run duration with a range." Every
 * schedule frame the capture leg took read "Unavailable." instead, on a card
 * whose resolver hard-coded the row to `null` — while the SAME row on the run
 * page's scheduling step had been drawing a real estimate from the same
 * estimator all along.
 *
 * PINNED THROUGH THE DEPENDENCY. The estimator is stubbed and made to answer
 * something the card could not have derived on its own, so a filled row can only
 * have come from it. And the three things the resolver is careful about are
 * pinned beside it: the estimate is asked for ONLY on the phase that draws the
 * row, it is asked ONCE per template however often the card re-resolves, and a
 * failure costs the row rather than the card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveProposalForReader = vi.fn();
const estimateFromHistory = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: vi.fn(),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  describeProposalSchedule: () => "Every weekday at 8:00 AM",
}));
vi.mock("@cinatra-ai/agents/trigger-duration-estimate", () => ({
  estimateFromHistory: (...a: unknown[]) => estimateFromHistory(...a),
}));

import {
  DURATION_COPY_MEMO_MAX,
  resolveTriggerScheduleProposalCard,
} from "../trigger-schedule-proposal-card";

const READER = { userId: "u-1", orgId: "org-1" };

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

/** A DISTINCT template id per case, so the resolver's per-template memo cannot
 *  carry one case's answer into the next. */
function heldResolution(phase: "proposal" | "expired", templateId: string) {
  return {
    phase,
    proposal: {
      templateId,
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

function durationRow(view: unknown): unknown {
  return view && typeof view === "object" && "durationCopy" in view
    ? (view as { durationCopy: unknown }).durationCopy
    : undefined;
}

beforeEach(() => {
  resolveProposalForReader.mockReset();
  estimateFromHistory.mockReset();
});

describe("the row a live proposal draws", () => {
  it("is a RANGE, from the estimator the run page's own form already reads", async () => {
    estimateFromHistory.mockResolvedValue({
      source: "history",
      prepMinSeconds: 120,
      prepMaxSeconds: 600,
      gatedMinSeconds: 60,
      gatedMaxSeconds: 300,
      confidence: "high",
      notes: "",
      computedAt: "2026-08-29T06:00:00.000Z",
    });
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal", "tpl-range"));

    const card = await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });

    expect(card.view?.phase).toBe("proposal");
    // 120+60 = 3 min, 600+300 = 15 min.
    expect(durationRow(card.view)).toBe("3 min–15 min.");
    // Asked about the template the PROPOSAL names, and nothing else.
    expect(estimateFromHistory).toHaveBeenCalledWith("tpl-range");
  });

  it("says the app's own word where the estimator has no answer", async () => {
    estimateFromHistory.mockResolvedValue(null);
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal", "tpl-none"));
    const card = await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    expect(durationRow(card.view)).toBe("Unavailable.");
  });

  it("costs the ROW and never the card when the estimate cannot be worked out", async () => {
    estimateFromHistory.mockRejectedValue(new Error("the store is down"));
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal", "tpl-throws"));
    const card = await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    // The card is still drawn, and still confirmable.
    expect(card.view?.phase).toBe("proposal");
    expect(card.state).toEqual({ state: "pending", canDecide: true, canComment: false });
    expect(durationRow(card.view)).toBeNull();
  });

  it("asks ONCE per template, however often the card re-resolves", async () => {
    estimateFromHistory.mockResolvedValue(null);
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal", "tpl-memo"));
    await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    expect(estimateFromHistory).toHaveBeenCalledTimes(1);
  });
});

describe("and it is asked for on the phase that draws it, and no other", () => {
  it("an EXPIRED reading pays for no estimate", async () => {
    resolveProposalForReader.mockResolvedValue(heldResolution("expired", "tpl-expired"));
    const card = await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    expect(card.view?.phase).toBe("expired");
    expect(estimateFromHistory).not.toHaveBeenCalled();
  });
});

describe("the memo is bounded, not only aged", () => {
  it("gives a template back once later ones have crowded it out", async () => {
    estimateFromHistory.mockResolvedValue(null);
    // Every entry written here is FRESH, so nothing is dropped for age: the only
    // thing that can remove one is the cap.
    const crowd = Array.from(
      { length: DURATION_COPY_MEMO_MAX + 8 },
      (_, i) => `tpl-crowd-${i}`,
    );
    for (const templateId of crowd) {
      resolveProposalForReader.mockResolvedValue(heldResolution("proposal", templateId));
      await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    }
    const filled = estimateFromHistory.mock.calls.length;

    // THE ONE STILL THERE. The newest write is inside the cap, so re-reading it
    // costs nothing — the memo is still a memo.
    const newest = crowd[crowd.length - 1]!;
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal", newest));
    await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    expect(estimateFromHistory.mock.calls.length).toBe(filled);

    // THE ONE THAT WENT. More templates were written than the table may hold, so
    // the earliest of them is gone and is asked about again — which is the whole
    // property: a long-lived process cannot accumulate one entry per template it
    // has ever seen.
    const earliest = crowd[0]!;
    resolveProposalForReader.mockResolvedValue(heldResolution("proposal", earliest));
    await resolveTriggerScheduleProposalCard({ ref: "a-ref", ...READER });
    expect(estimateFromHistory.mock.calls.length).toBe(filled + 1);
  });
});
