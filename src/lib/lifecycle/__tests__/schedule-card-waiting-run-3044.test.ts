// THE WAITING RUN'S CARD, AND THE CONFIRM THAT ACTS ON THAT RUN (cinatra#3044).
//
// The card the run outbox writes into a conversation is addressed by the
// RUN-SCOPED schedule ref. Two things follow, and neither existed before:
//
//   1. THE READ. A run parked at its schedule moment resolves to a DRAWN card —
//      the scheduler form's rows, from the schedule moment's one stated default,
//      and a Confirm floor — with the same `absent` for every reader the run's
//      own access control refuses.
//   2. THE PRESS. Confirm on that card must NOT take the proposal road: there is
//      no token, and `confirmTriggerScheduleProposal` CREATES a run. It takes the
//      existing run-trigger path for the run that is already waiting, which is
//      what leaves exactly one run. A retry or a double press finds the schedule
//      already set and says so; a press after the run has moved on is refused.
//
// The service and the trigger path are stubbed: what is under test is the
// ROUTING and the refusals this module owns, not the arming those paths already
// prove for themselves.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveProposalForRun = vi.fn();
const resolveProposalForReader = vi.fn();
const confirmTriggerScheduleProposal = vi.fn();
const armRunScheduleForActor = vi.fn();
const updateRunTriggerScheduleForActor = vi.fn();
const stopRecurringTriggerForActor = vi.fn();

vi.mock("@cinatra-ai/agents/trigger-schedule-proposal-service", () => ({
  resolveProposalForRun: (...a: unknown[]) => resolveProposalForRun(...a),
  resolveProposalForReader: (...a: unknown[]) => resolveProposalForReader(...a),
  confirmTriggerScheduleProposal: (...a: unknown[]) => confirmTriggerScheduleProposal(...a),
  adjustTriggerSchedule: vi.fn(),
  reproposeExpiredSchedule: vi.fn(),
  describeProposalSchedule: () => "Every weekday at 9:00 AM",
  PROPOSAL_REFUSALS: {
    invalid: "That schedule isn't one I can set.",
    notRunnable: "This agent can't be run on this instance.",
  },
}));

vi.mock("@cinatra-ai/agents/trigger-service", () => ({
  armRunScheduleForActor: (...a: unknown[]) => armRunScheduleForActor(...a),
  updateRunTriggerScheduleForActor: (...a: unknown[]) =>
    updateRunTriggerScheduleForActor(...a),
  stopRecurringTriggerForActor: (...a: unknown[]) => stopRecurringTriggerForActor(...a),
}));

import { encodeScheduleRunRef } from "../lifecycle-card-ref";
import {
  SCHEDULE_DECISION_REFUSAL,
  decideTriggerScheduleProposal,
  resolveTriggerScheduleProposalCard,
} from "../trigger-schedule-proposal-card";

const RUN_ID = "run-3044-waiting";
const RUN_REF = encodeScheduleRunRef({ runId: RUN_ID })!;
const READER = { userId: "u-1", orgId: "org-1" };
const ROLE = { role: null };

const WAITING = {
  phase: "run_pending" as const,
  runId: RUN_ID,
  agentName: "Weekly cohort sweep",
  canConfirm: true,
  restrictedReason: null,
};

const SCHEDULED_ROWS = {
  kind: "scheduled" as const,
  runAt: "2030-01-01T09:00",
  timezone: "Europe/Berlin",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveProposalForReader.mockResolvedValue({ phase: "absent" });
  resolveProposalForRun.mockResolvedValue(WAITING);
  armRunScheduleForActor.mockResolvedValue({
    ok: true,
    runId: RUN_ID,
    alreadyArmed: false,
  });
});

// ---------------------------------------------------------------------------
// 1 — the read
// ---------------------------------------------------------------------------

describe("the waiting run's card", () => {
  it("draws the scheduler form with an editable row set and a live Confirm floor", async () => {
    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });

    expect(card.state).toEqual({ state: "pending", canDecide: true, canComment: false });
    expect(card.view).not.toBeNull();
    expect(card.view!.phase).toBe("proposal");
    if (card.view!.phase !== "proposal") return;
    expect(card.view!.agentName).toBe("Weekly cohort sweep");
    // THE ROWS ARE THE SCHEDULE MOMENT'S OWN DEFAULT, applied — the same one
    // decision the run page's scheduling step opens on.
    expect(card.view!.schedule).toEqual({ kind: "immediate" });
    expect(card.view!.canConfirm).toBe(true);
    // The card says which road its Confirm takes, so one press means one thing.
    expect(card.view!.runPending).toBe(true);
  });

  it("is DRAWN and restricted — never absent — for a reader who may not confirm", async () => {
    resolveProposalForRun.mockResolvedValue({
      ...WAITING,
      canConfirm: false,
      restrictedReason: "This agent can't be run on this instance.",
    });

    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });

    expect(card.state).toEqual({
      state: "restricted",
      canDecide: false,
      canComment: false,
      reason: "This agent can't be run on this instance.",
    });
    expect(card.view!.phase).toBe("proposal");
  });

  it("draws nothing at all for a reader the run refuses", async () => {
    resolveProposalForRun.mockResolvedValue({ phase: "absent" });

    const card = await resolveTriggerScheduleProposalCard({ ref: RUN_REF, ...READER });

    expect(card).toEqual({ state: { state: "absent" }, view: null, firedOnce: false });
  });
});

// ---------------------------------------------------------------------------
// 2 — the press
// ---------------------------------------------------------------------------

describe("Confirm on the waiting run's card", () => {
  it("takes the RUN-TRIGGER path, never the proposal road that would create a run", async () => {
    const outcome = await decideTriggerScheduleProposal({
      ref: RUN_REF,
      op: "confirm",
      schedule: SCHEDULED_ROWS,
      ...READER,
      ...ROLE,
    });

    expect(outcome).toEqual({ kind: "confirmed", runId: RUN_ID, alreadyConfirmed: false });
    // EXACTLY ONE RUN: the confirm transaction — the one path that CREATES a run
    // — is never reached from a run-addressed ref.
    expect(confirmTriggerScheduleProposal).not.toHaveBeenCalled();
    expect(armRunScheduleForActor).toHaveBeenCalledWith(
      { userId: "u-1", role: null, source: "ui" },
      { runId: RUN_ID, schedule: SCHEDULED_ROWS },
    );
  });

  it("falls back to the row the card was drawn on when the press carried none", async () => {
    const outcome = await decideTriggerScheduleProposal({
      ref: RUN_REF,
      op: "confirm",
      ...READER,
      ...ROLE,
    });

    expect(outcome.kind).toBe("confirmed");
    expect(armRunScheduleForActor).toHaveBeenCalledWith(expect.anything(), {
      runId: RUN_ID,
      schedule: { kind: "immediate" },
    });
  });

  it("is IDEMPOTENT — a retry that re-reads the settled run never reaches the arming path", async () => {
    resolveProposalForRun.mockResolvedValue({ phase: "settled", runId: RUN_ID });

    const outcome = await decideTriggerScheduleProposal({
      ref: RUN_REF,
      op: "confirm",
      schedule: SCHEDULED_ROWS,
      ...READER,
      ...ROLE,
    });

    expect(outcome).toEqual({ kind: "confirmed", runId: RUN_ID, alreadyConfirmed: true });
    // Nothing was armed a second time.
    expect(armRunScheduleForActor).not.toHaveBeenCalled();
  });

  it("is IDEMPOTENT under the RACE the re-read cannot see — the arming path's answer is carried through", async () => {
    // Both presses resolved the run as waiting; the other one armed it first, and
    // the arming path — which decides inside the trigger claim — says so. The
    // reader gets the same "already confirmed" answer rather than a second arm
    // silently replacing the schedule the first press set.
    armRunScheduleForActor.mockResolvedValue({
      ok: true,
      runId: RUN_ID,
      alreadyArmed: true,
    });

    await expect(
      decideTriggerScheduleProposal({
        ref: RUN_REF,
        op: "confirm",
        schedule: SCHEDULED_ROWS,
        ...READER,
        ...ROLE,
      }),
    ).resolves.toEqual({ kind: "confirmed", runId: RUN_ID, alreadyConfirmed: true });
  });

  it("passes the arming path's MOVED-ON refusal through as reader-facing copy", async () => {
    armRunScheduleForActor.mockResolvedValue({
      ok: false,
      error:
        "This run is no longer waiting for a schedule — it has already moved on. Start a new run to schedule it again.",
    });

    await expect(
      decideTriggerScheduleProposal({
        ref: RUN_REF,
        op: "confirm",
        schedule: SCHEDULED_ROWS,
        ...READER,
        ...ROLE,
      }),
    ).resolves.toEqual({
      kind: "error",
      message:
        "This run is no longer waiting for a schedule — it has already moved on. Start a new run to schedule it again.",
    });
  });

  it("refuses a press on a DRAWN BUT DEAD floor with the reader's own reason", async () => {
    // The reader may see the run and may not configure it — an organization
    // administrator who is not the run's owner. The card draws the reason; a
    // press that reaches the server anyway gets the same sentence, and nothing
    // is armed.
    resolveProposalForRun.mockResolvedValue({
      ...WAITING,
      canConfirm: false,
      restrictedReason: "Only the person who started this run can set its schedule.",
    });

    await expect(
      decideTriggerScheduleProposal({
        ref: RUN_REF,
        op: "confirm",
        schedule: SCHEDULED_ROWS,
        ...READER,
        ...ROLE,
      }),
    ).resolves.toEqual({
      kind: "error",
      message: "Only the person who started this run can set its schedule.",
    });
    expect(armRunScheduleForActor).not.toHaveBeenCalled();
  });

  it("is REFUSED once the run has moved on, in the one sentence every denial gets", async () => {
    resolveProposalForRun.mockResolvedValue({ phase: "absent" });

    const outcome = await decideTriggerScheduleProposal({
      ref: RUN_REF,
      op: "confirm",
      schedule: SCHEDULED_ROWS,
      ...READER,
      ...ROLE,
    });

    expect(outcome).toEqual({ kind: "not-permitted", message: SCHEDULE_DECISION_REFUSAL });
    expect(armRunScheduleForActor).not.toHaveBeenCalled();
  });

  it("carries the reader's own STANDING into the resolve the press re-runs", async () => {
    const access = {
      actor: { userId: "org-admin" } as never,
      roles: { orgRole: "admin", actorOrganizationId: "org-1" } as never,
    };

    await decideTriggerScheduleProposal({
      ref: RUN_REF,
      op: "confirm",
      schedule: SCHEDULED_ROWS,
      ...READER,
      ...ROLE,
      access,
    });

    // …and, beside it, what the reference records (cinatra#3044): this one was
    // minted plain, so the press asks exactly what the read asked.
    expect(resolveProposalForRun).toHaveBeenCalledWith(RUN_ID, READER, access, {
      fromScheduleStep: false,
    });
  });

  it("refuses rows that are not §VI's closed vocabulary, and arms nothing", async () => {
    const outcome = await decideTriggerScheduleProposal({
      ref: RUN_REF,
      op: "confirm",
      schedule: { kind: "recurring", cron: "0 9 * * 1-5" },
      ...READER,
      ...ROLE,
    });

    expect(outcome.kind).toBe("error");
    expect(armRunScheduleForActor).not.toHaveBeenCalled();
  });

  it("collapses the trigger path's own authorization refusals into the one sentence", async () => {
    armRunScheduleForActor.mockResolvedValue({ ok: false, error: "forbidden" });

    await expect(
      decideTriggerScheduleProposal({
        ref: RUN_REF,
        op: "confirm",
        schedule: SCHEDULED_ROWS,
        ...READER,
        ...ROLE,
      }),
    ).resolves.toEqual({ kind: "not-permitted", message: SCHEDULE_DECISION_REFUSAL });
  });

  it("passes a STATE refusal through as reader-facing copy", async () => {
    armRunScheduleForActor.mockResolvedValue({
      ok: false,
      error: "This run has already finished — it can't be run again. Start a new run instead.",
    });

    await expect(
      decideTriggerScheduleProposal({
        ref: RUN_REF,
        op: "confirm",
        schedule: SCHEDULED_ROWS,
        ...READER,
        ...ROLE,
      }),
    ).resolves.toEqual({
      kind: "error",
      message:
        "This run has already finished — it can't be run again. Start a new run instead.",
    });
  });

  it("leaves the PROPOSAL road exactly where it was for a token ref", async () => {
    confirmTriggerScheduleProposal.mockResolvedValue({
      ok: true,
      runId: "run-from-a-proposal",
      alreadyConfirmed: false,
    });

    const outcome = await decideTriggerScheduleProposal({
      ref: "cst_a_proposal_token",
      op: "confirm",
      ...READER,
      ...ROLE,
    });

    expect(outcome).toEqual({
      kind: "confirmed",
      runId: "run-from-a-proposal",
      alreadyConfirmed: false,
    });
    expect(armRunScheduleForActor).not.toHaveBeenCalled();
  });
});
