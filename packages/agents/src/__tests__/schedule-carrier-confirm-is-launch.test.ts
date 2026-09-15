/**
 * THE TWO SCHEDULE CARRIERS, AND WHY CONFIRM IS LAUNCH (cinatra#2928, epic #2926 W2a).
 *
 * The schedule moment has two carriers. In a conversation the carrier is the
 * schedule the person STATED, held: a signed, single-use reference with a
 * thirty-minute life, readable only by the person who stated it, writing no run
 * and no trigger. On the run page the carrier is a run that exists and is parked
 * at the moment.
 *
 * Confirm crosses between them, and it crosses by LAUNCHING — not by advancing.
 * There is no run to advance until Confirm creates one, which is exactly why
 * this suite exists: routing Confirm through the coordinator is what makes
 * "every way of starting an agent calls launch" true of the schedule card too.
 *
 * WHAT IS PROVEN ELSEWHERE, and deliberately not repeated here:
 *   · the held reference's unforgeability, opacity, lifetime and reader binding
 *     — `src/lib/__tests__/trigger-schedule-proposal-token.test.ts`;
 *   · single consumption, the one transaction, and two racing Confirms
 *     producing one run — the real-Postgres tier in
 *     `trigger-schedule-proposal.integration.test.ts`.
 * What is proven HERE is the routing and the refusals around it: that the
 * creation goes through launch carrying the companion write intact, that a
 * second Confirm launches nothing, and that every unusable reference refuses
 * indistinguishably and launches nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "user-2928-confirm";
const ORG = "org-2928-confirm";
const TEMPLATE = "tmpl-2928-confirm";
const RUN_ID = "run-2928-confirmed";

const launchAgentRun = vi.fn();
const spendProposalWithinTx = vi.fn(async (..._a: unknown[]): Promise<void> => {});
const verifyTriggerScheduleProposalToken = vi.fn();
const readProposalConsume = vi.fn();
const readAgentTemplateById = vi.fn();
const assertAgentPackageRunnable = vi.fn(async (): Promise<{ error: string } | null> => null);
const driveInstallInner = vi.fn(async () => undefined);

vi.mock("../lifecycle-coordinator", () => ({
  launchAgentRun: (...a: unknown[]) => launchAgentRun(...a),
}));
vi.mock("@/lib/trigger-schedule-proposal-token", () => ({
  verifyTriggerScheduleProposalToken: (...a: unknown[]) =>
    verifyTriggerScheduleProposalToken(...a),
  proposalConsumeKey: (nonce: string) => `consume:${nonce}`,
}));
vi.mock("../trigger-schedule-proposal-store", () => ({
  ProposalAlreadyConsumedError: class ProposalAlreadyConsumedError extends Error {},
  readProposalConsume: (...a: unknown[]) => readProposalConsume(...a),
  readInstallIntent: vi.fn(async () => null),
  spendProposalWithinTx: (...a: unknown[]) => spendProposalWithinTx(...a),
  claimPendingInstallIntents: vi.fn(async () => []),
  markInstallIntentArmed: vi.fn(async () => undefined),
  markInstallIntentDone: vi.fn(async () => undefined),
  parkInstallIntent: vi.fn(async () => undefined),
  releaseInstallIntent: vi.fn(async () => undefined),
}));
vi.mock("../store", () => ({
  RunTransitionError: class RunTransitionError extends Error {},
  readAgentRunById: vi.fn(async () => null),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../runtime-install-gate", () => ({
  assertAgentPackageRunnable: () => assertAgentPackageRunnable(),
}));
vi.mock("../trigger-store", () => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn(async () => null),
}));
vi.mock("../trigger-schedule", () => ({ scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })) }));
vi.mock("../trigger-service", () => ({ setRunTriggerForActor: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ kind: "member" })),
}));
vi.mock("../trigger-schedule-propose", () => ({
  // The REAL conversion is a pure function of a naive wall clock and a zone;
  // this stub reads the fixture's own ISO-shaped value so the suite stays about
  // the routing rather than about datetime arithmetic.
  naiveDatetimeToUtcMs: (v: string) => new Date(`${v}:00Z`).getTime(),
  proposeTriggerSchedule: vi.fn(),
  adjustTriggerSchedule: vi.fn(),
}));

import { confirmTriggerScheduleProposal, PROPOSAL_REFUSALS } from "../trigger-schedule-proposal-service";

const actor = { userId: USER, orgId: ORG };

/** A schedule the person stated: a one-off, a week out. */
function naive(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
}
const STATED_SCHEDULE = {
  kind: "scheduled" as const,
  timezone: "UTC",
  runAt: naive(7 * 86_400_000),
};

function heldProposal() {
  return {
    nonce: "nonce-2928",
    templateId: TEMPLATE,
    userId: USER,
    orgId: ORG,
    schedule: STATED_SCHEDULE,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyTriggerScheduleProposalToken.mockReturnValue(heldProposal());
  readProposalConsume.mockResolvedValue(null);
  readAgentTemplateById.mockResolvedValue({
    id: TEMPLATE,
    orgId: ORG,
    name: "Weekly digest",
    packageName: "@cinatra/x2928",
    packageVersion: "1.0.0",
  });
  assertAgentPackageRunnable.mockResolvedValue(null);
  launchAgentRun.mockResolvedValue({
    carrier: { kind: "run", run: { id: RUN_ID, orgId: ORG, status: "pending_input" } },
    status: "pending_input",
    moment: null,
  });
  void driveInstallInner;
});

describe("Confirm is LAUNCH, not advance", () => {
  it("creates the run through the coordinator's launch entry", async () => {
    const result = await confirmTriggerScheduleProposal(actor, "held-token");

    expect(result).toMatchObject({ ok: true, runId: RUN_ID, alreadyConfirmed: false });
    expect(launchAgentRun).toHaveBeenCalledTimes(1);
    expect(launchAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        producer: "schedule_confirm",
        interactive: true,
        create: expect.objectContaining({ kind: "pre_dispatch" }),
      }),
    );
  });

  it("keeps the companion write, so the run and its schedule commit together", async () => {
    // THE ONE TRANSACTION. Confirm's whole shape is that the run row, the
    // single-use consume edge and the schedule-install intent land or fail
    // together — so the launch has to carry the companion write through
    // untouched. Routing that dropped it would leave a second Confirm able to
    // create a second run.
    //
    // THE HOOK IS CALLED, not merely inspected. Asserting that the field holds
    // a function proves nothing about what the function does: a routing that
    // handed over an empty closure would satisfy that and lose the consume
    // edge. So this launch RUNS the hook, exactly as the creator's guarded
    // transaction does, and reads what it wrote.
    launchAgentRun.mockImplementation(
      async (input: {
        create: { input: { withinCreateTx?: (tx: unknown, run: { id: string; orgId: string }) => Promise<void> } };
      }) => {
        await input.create.input.withinCreateTx?.(
          { fakeTx: true },
          { id: RUN_ID, orgId: ORG },
        );
        return {
          carrier: { kind: "run", run: { id: RUN_ID, orgId: ORG, status: "pending_input" } },
          status: "pending_input",
          moment: null,
        };
      },
    );

    await confirmTriggerScheduleProposal(actor, "held-token");

    const call = launchAgentRun.mock.calls[0][0] as {
      create: { input: { withinCreateTx?: unknown; templateId: string; runBy: string; orgId: string } };
    };
    expect(typeof call.create.input.withinCreateTx).toBe("function");
    expect(call.create.input).toMatchObject({
      templateId: TEMPLATE,
      runBy: USER,
      orgId: ORG,
    });
    // …and the hook spent the proposal against the run the launch created,
    // inside the transaction it was handed.
    expect(spendProposalWithinTx).toHaveBeenCalledTimes(1);
    expect(spendProposalWithinTx).toHaveBeenCalledWith(
      { fakeTx: true },
      expect.objectContaining({
        consumeKey: "consume:nonce-2928",
        runId: RUN_ID,
        orgId: ORG,
        templateId: TEMPLATE,
        consumedBy: USER,
        install: expect.objectContaining({ triggerType: "scheduled" }),
      }),
    );
  });

  it("rolls the run back with the companion write — a lost consume creates no run", async () => {
    // The other half of "together". If the consume insert loses its race, the
    // run it was creating must go with it. The creator's transaction is what
    // performs that; what this asserts is that Confirm lets the failure OUT of
    // the launch instead of swallowing it and reporting a run.
    launchAgentRun.mockImplementation(
      async (input: {
        create: { input: { withinCreateTx?: (tx: unknown, run: { id: string; orgId: string }) => Promise<void> } };
      }) => {
        // The guarded transaction calls the hook and unwinds on a throw.
        await input.create.input.withinCreateTx?.({ fakeTx: true }, { id: RUN_ID, orgId: ORG });
        throw new Error("rolled back with the companion write");
      },
    );
    spendProposalWithinTx.mockRejectedValueOnce(new Error("consume lost the race"));

    const result = await confirmTriggerScheduleProposal(actor, "held-token");

    expect(result.ok).toBe(false);
  });

  it("does NOT dispatch the run — the schedule decides when it starts", async () => {
    // Confirm ARMS what the person stated. A run enqueued here would start now,
    // which is the opposite of what they confirmed.
    await confirmTriggerScheduleProposal(actor, "held-token");

    const call = launchAgentRun.mock.calls[0][0] as { dispatch: { kind: string; why?: string } };
    expect(call.dispatch.kind).toBe("await_trigger");
    expect(call.dispatch.why?.length ?? 0).toBeGreaterThan(20);
  });
});

describe("a second Confirm of the same stated schedule", () => {
  it("answers 'already confirmed' with the original run and launches NOTHING", async () => {
    readProposalConsume.mockResolvedValue({ runId: RUN_ID, orgId: ORG });

    const result = await confirmTriggerScheduleProposal(actor, "held-token");

    expect(result).toMatchObject({ ok: true, runId: RUN_ID, alreadyConfirmed: true });
    expect(launchAgentRun).not.toHaveBeenCalled();
  });
});

describe("an unusable reference refuses indistinguishably, and launches nothing", () => {
  it.each([
    ["expired", null],
    ["foreign", null],
    ["forged", null],
  ])("a %s reference gets the one refusal", async (_kind, verified) => {
    // ONE ANSWER for all three. The reader learns only that this card can no
    // longer be confirmed — never which of the three it was, because the
    // difference is exactly the oracle an attacker wants.
    verifyTriggerScheduleProposalToken.mockReturnValue(verified);

    const result = await confirmTriggerScheduleProposal(actor, "unusable-token");

    expect(result).toEqual({ ok: false, error: PROPOSAL_REFUSALS.invalid });
    expect(launchAgentRun).not.toHaveBeenCalled();
  });

  it("refuses an agent this reader's organization does not own, and launches nothing", async () => {
    readAgentTemplateById.mockResolvedValue({ id: TEMPLATE, orgId: "some-other-org" });

    const result = await confirmTriggerScheduleProposal(actor, "held-token");

    expect(result).toEqual({ ok: false, error: PROPOSAL_REFUSALS.unknownAgent });
    expect(launchAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a moment that has already passed, and launches nothing", async () => {
    // A held reference is good for its whole life, so a one-off stated for 09:00
    // can reach Confirm at 09:05. Creating the run first and failing the install
    // afterwards would leave a run nobody can explain.
    verifyTriggerScheduleProposalToken.mockReturnValue({
      ...heldProposal(),
      schedule: { kind: "scheduled" as const, timezone: "UTC", runAt: naive(-86_400_000) },
    });

    const result = await confirmTriggerScheduleProposal(actor, "held-token");

    expect(result.ok).toBe(false);
    expect(launchAgentRun).not.toHaveBeenCalled();
  });
});
