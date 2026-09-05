// THE FORM'S OWN BUTTON RECORDS WHAT IT COMMITTED (cinatra#2934, the
// convergence round of the FOURTH fix leg).
//
// WHAT WAS STILL OPEN. The fourth fix leg closed the placement re-apply with an
// identity boundary: a save records WHICH placement rows it consumed, and a
// consumed row is never carried again whatever the two clocks say. It wrote
// that receipt on ONE of the two roads — the one where the person asks the
// assistant to save. The other road is the one they take most: pressing **Save
// changes** on the card itself. That press commits exactly what the rows are
// showing, which IS what the window placed there, and it recorded nothing — so
// a later bare ask could carry those same placements again and re-apply them
// over rows that had moved on. The whole point of an identity boundary is that
// every save writes it.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-card-save-receipt";

const resolveProposalForRun = vi.fn();
const resolveProposalForReader = vi.fn();
vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: (...a: unknown[]) => resolveProposalForRun(...a),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  adjustTriggerSchedule: vi.fn(),
  reproposeExpiredSchedule: vi.fn(),
  confirmTriggerScheduleProposal: vi.fn(),
  describeProposalSchedule: () => "Every weekday at 09:00",
  PROPOSAL_REFUSALS: { invalid: "invalid", notRunnable: "not runnable" },
}));

const updateRunTriggerScheduleForActor = vi.fn();
vi.mock("@cinatra-ai/agents/trigger-service", () => ({
  updateRunTriggerScheduleForActor: (...a: unknown[]) =>
    updateRunTriggerScheduleForActor(...a),
  stopRecurringTriggerForActor: vi.fn(),
}));

const readRunWindowPendingPlacementSequences = vi.fn();
const recordRunWindowPlacementsSaved = vi.fn();
vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  readRunWindowPendingPlacementSequences: (...a: unknown[]) =>
    readRunWindowPendingPlacementSequences(...a),
  recordRunWindowPlacementsSaved: (...a: unknown[]) =>
    recordRunWindowPlacementsSaved(...a),
}));

import { decideTriggerScheduleProposal } from "../trigger-schedule-proposal-card";
import { encodeScheduleRunRef } from "../lifecycle-card-ref";

const RUN = "run_card_save_receipt";
const REF = encodeScheduleRunRef({ runId: RUN })!;
const READER = { userId: "u-owner", orgId: "org-1", role: null };

const SCHEDULE = {
  kind: "scheduled",
  runAt: "2026-09-02T10:30",
  timezone: "Europe/Berlin",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveProposalForRun.mockResolvedValue({ phase: "settled", runId: RUN });
  resolveProposalForReader.mockResolvedValue({ phase: "absent" });
  updateRunTriggerScheduleForActor.mockResolvedValue({ ok: true, runId: RUN });
  readRunWindowPendingPlacementSequences.mockResolvedValue([4, 7]);
  recordRunWindowPlacementsSaved.mockResolvedValue(undefined);
});

describe("pressing Save changes on the card", () => {
  it("records the placements it committed, by row identity", async () => {
    const out = await decideTriggerScheduleProposal({
      ref: REF,
      op: "save",
      schedule: SCHEDULE,
      ...READER,
    } as never);

    expect(out).toEqual({ kind: "saved", runId: RUN });
    // ONLY THIS PERSON'S, ONLY THIS FORM'S — the same two questions the ask
    // road's carry asks.
    expect(readRunWindowPendingPlacementSequences).toHaveBeenCalledTimes(1);
    const [runId, opts] = readRunWindowPendingPlacementSequences.mock.calls[0] as [
      string,
      { placedBy: string; refMatches: (ref: string) => boolean },
    ];
    expect(runId).toBe(RUN);
    expect(opts.placedBy).toBe(READER.userId);
    expect(opts.refMatches(REF)).toBe(true);
    // A ref MINTED FRESH for the same run is the same form: the armed
    // schedule's encoding is randomised, so bytes are not identity.
    expect(opts.refMatches(encodeScheduleRunRef({ runId: RUN })!)).toBe(true);
    expect(opts.refMatches(encodeScheduleRunRef({ runId: "some_other_run" })!)).toBe(false);

    expect(recordRunWindowPlacementsSaved).toHaveBeenCalledTimes(1);
    expect(recordRunWindowPlacementsSaved.mock.calls[0]![0]).toMatchObject({
      runId: RUN,
      ref: REF,
      savedBy: READER.userId,
      sequences: [4, 7],
    });
  });

  it("writes NOTHING when the save itself did not land", async () => {
    // A receipt for a change nobody saved would discard the person's own form.
    updateRunTriggerScheduleForActor.mockResolvedValue({ ok: false, error: "forbidden" });

    await decideTriggerScheduleProposal({
      ref: REF,
      op: "save",
      schedule: SCHEDULE,
      ...READER,
    } as never);

    expect(recordRunWindowPlacementsSaved).not.toHaveBeenCalled();
  });

  it("never fails the press when the receipt cannot be written", async () => {
    // The boundary degrades to the timestamp one — where the road stood before
    // receipts existed — and the person's press still succeeds.
    recordRunWindowPlacementsSaved.mockRejectedValue(new Error("store down"));

    const out = await decideTriggerScheduleProposal({
      ref: REF,
      op: "save",
      schedule: SCHEDULE,
      ...READER,
    } as never);

    expect(out).toEqual({ kind: "saved", runId: RUN });
  });

  it("asks for no receipt at all when nothing is standing", async () => {
    readRunWindowPendingPlacementSequences.mockResolvedValue([]);

    await decideTriggerScheduleProposal({
      ref: REF,
      op: "save",
      schedule: SCHEDULE,
      ...READER,
    } as never);

    expect(recordRunWindowPlacementsSaved).not.toHaveBeenCalled();
  });
});
