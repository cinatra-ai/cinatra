/**
 * A RUN WAITING AT ITS SCHEDULE HAS A READING (cinatra#3044).
 *
 * `resolveProposalForRun` used to have no pre-confirm phase at all, and said so:
 * "Confirm CREATES the run, so a run exists only after a proposal was
 * confirmed." That was true of the road the proposal token travels and false of
 * the road a run travels: a run started from a conversation finishes its setup,
 * parks at `pending_trigger` and waits for "When should this run?" — it EXISTS,
 * it WAITS, and it has no trigger row. The conversation had no reading for it,
 * so the card the outbox now writes into the turn would resolve `absent` and
 * draw nothing.
 *
 * WHAT IS PINNED HERE:
 *
 *   1. The waiting run resolves to the PENDING-RUN phase — the rows the schedule
 *      moment's own default opens on, and a Confirm floor — before any trigger
 *      row or install intent exists.
 *   2. Every refusal the run-addressed road already made stays made: another
 *      organization, a reader the run's own access control refuses, a stranger
 *      where no standing was presented, a vanished template. Each answers
 *      `absent` and carries NOTHING about the run.
 *   3. It is the WAIT that is drawn, not the status: a run that is not parked at
 *      its schedule moment answers `absent`, so a moment whose record lost its
 *      compare-and-set draws no card rather than a card for a run that moved on.
 *   4. The floor is resolved against the reader — an agent the instance would
 *      refuse to run is `restricted`, drawn, with the reason on screen.
 *
 * Harness mirrors `schedule-over-3004.test.ts`: the service runs for real and
 * only its collaborators are stubbed, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/schedule-pending-run-3044.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-3044-waiting";
const OWNER_ID = "user-3044-owner";
const ORG_ID = "org-3044";
const TEMPLATE_ID = "tmpl-3044";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null as unknown),
  createAgentRunPendingInput: vi.fn(),
  transitionRunStatus: vi.fn(async (): Promise<void> => {}),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => ({ runId: "", jobId: "", status: "queued" as const })),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn<
    (runId?: string) => Promise<Record<string, unknown> | null>
  >(async () => null),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
  stopRunTriggerInDb: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-3044" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
const proposalStore = vi.hoisted(() => ({
  ProposalAlreadyConsumedError: class extends Error {},
  claimPendingInstallIntents: vi.fn(async () => []),
  markInstallIntentArmed: vi.fn(),
  markInstallIntentDone: vi.fn(),
  parkInstallIntent: vi.fn(),
  readInstallIntent: vi.fn(async () => null as unknown),
  readProposalConsume: vi.fn(async () => null as unknown),
  readProposalConsumeByRunId: vi.fn(async () => null as unknown),
  releaseInstallIntent: vi.fn(),
  spendProposalWithinTx: vi.fn(),
}));
const installGate = vi.hoisted(() => ({
  assertAgentPackageRunnable: vi.fn(async () => null as string | null),
}));

vi.mock("../store", () => store);
vi.mock("../trigger-store", () => triggerStore);
vi.mock("../trigger-schedule", () => schedule);
vi.mock("../trigger-schedule-proposal-store", () => proposalStore);
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-enqueue", () => enqueue);
vi.mock("../runtime-install-gate", () => installGate);

// The trigger claim reaches Postgres for its advisory lock and this tier has no
// database. The pass-through preserves the CONTRACT the claim gives its callers
// — the body decides on the row as read AT CLAIM TIME — while the row itself
// keeps coming from this file's own mocked store. That is what lets the
// serialized "somebody answered first" case be driven honestly below.
const claim = vi.hoisted(() => ({ withTriggerClaim: vi.fn() }));
vi.mock("../trigger-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trigger-claim")>();
  return { ...actual, withTriggerClaim: claim.withTriggerClaim };
});

import { PROPOSAL_REFUSALS, resolveProposalForRun } from "../trigger-schedule-proposal-service";
import { ARM_SCHEDULE_REFUSALS, armRunScheduleForActor } from "../trigger-service";
import type { RecurringConfig } from "../trigger-recurrence";

const READER = { userId: OWNER_ID, orgId: ORG_ID };

/** A complete §VI recurring selection — the vocabulary has no partial shape. */
const RECURRING_SELECTION: RecurringConfig = {
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
};

/** The run as the setup hand-off leaves it: parked, waiting, nothing armed. */
const WAITING_RUN = {
  id: RUN_ID,
  runBy: OWNER_ID,
  templateId: TEMPLATE_ID,
  orgId: ORG_ID,
  status: "pending_trigger",
  lifecycleMoment: "schedule",
  lifecycleCardKind: "trigger_schedule_proposal",
  lifecycleCardRef: "a-server-minted-ref",
};

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue(WAITING_RUN);
  store.readAgentTemplateById.mockResolvedValue({
    id: TEMPLATE_ID,
    name: "Weekly cohort sweep",
    packageName: "weekly-cohort-sweep",
    packageVersion: "1.0.0",
    orgId: ORG_ID,
  });
  triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
  proposalStore.readInstallIntent.mockResolvedValue(null);
  proposalStore.readProposalConsumeByRunId.mockResolvedValue(null);
  installGate.assertAgentPackageRunnable.mockResolvedValue(null);
  claim.withTriggerClaim.mockImplementation(
    async (runId: string, body: (live: unknown) => Promise<unknown>) =>
      body(await triggerStore.readRunTriggerByRunId(runId)),
  );
});

describe("the waiting run's own phase", () => {
  it("resolves BEFORE any trigger row or install intent exists", async () => {
    const resolution = await resolveProposalForRun(RUN_ID, READER);

    expect(
      resolution.phase,
      "a run parked at its schedule moment resolved to nothing, so the card in its conversation draws no DOM at all",
    ).toBe("run_pending");
    if (resolution.phase !== "run_pending") return;
    expect(resolution.runId).toBe(RUN_ID);
    expect(resolution.agentName).toBe("Weekly cohort sweep");
    expect(resolution.canConfirm).toBe(true);
    expect(resolution.restrictedReason).toBeNull();
    // Nothing was armed to read it off — that is the whole point of the phase.
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
  });

  it("is DRAWN and restricted — never absent — for an agent the instance would refuse to run", async () => {
    installGate.assertAgentPackageRunnable.mockResolvedValue("not installed here");

    const resolution = await resolveProposalForRun(RUN_ID, READER);

    expect(resolution.phase).toBe("run_pending");
    if (resolution.phase !== "run_pending") return;
    expect(resolution.canConfirm).toBe(false);
    expect(resolution.restrictedReason).toBe(PROPOSAL_REFUSALS.notRunnable);
  });

  it("is the WAIT that is drawn, not the status", async () => {
    // The moment's record lost its compare-and-set (the write is best-effort and
    // status-pinned), so the run does not state the schedule moment. Drawing a
    // card here would be a card for a run that is not waiting at one.
    store.readAgentRunById.mockResolvedValue({ ...WAITING_RUN, lifecycleMoment: null });
    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({ phase: "absent" });

    // …and a run that states the moment but has moved off the park is the same
    // answer, from the other direction.
    store.readAgentRunById.mockResolvedValue({ ...WAITING_RUN, status: "running" });
    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({ phase: "absent" });
  });
});

describe("who may read the waiting run's schedule", () => {
  it("answers another organization with nothing at all", async () => {
    await expect(
      resolveProposalForRun(RUN_ID, { userId: OWNER_ID, orgId: "org-other" }),
    ).resolves.toEqual({ phase: "absent" });
  });

  it("answers a stranger with nothing at all where no standing was presented", async () => {
    await expect(
      resolveProposalForRun(RUN_ID, { userId: "somebody-else", orgId: ORG_ID }),
    ).resolves.toEqual({ phase: "absent" });
  });

  it("asks the RUN's own access control when the reader's standing is presented", async () => {
    const access = {
      actor: { userId: "org-admin" } as never,
      roles: { orgRole: "admin", actorOrganizationId: ORG_ID } as never,
    };

    const resolution = await resolveProposalForRun(
      RUN_ID,
      { userId: "org-admin", orgId: ORG_ID },
      access,
    );

    expect(store.readAgentRunById).toHaveBeenCalledWith(RUN_ID, access.actor, access.roles);
    expect(resolution.phase).toBe("run_pending");
    // …AND THE FLOOR IS THE ONE THE SERVER WILL HONOUR (a convergence finding).
    // Run READ is the run's, which admits an organization administrator; ARMING
    // still needs the run's own owner or a platform administrator. They see the
    // card, the rows and the reason — never a live control the press refuses.
    if (resolution.phase !== "run_pending") return;
    expect(resolution.canConfirm).toBe(false);
    expect(resolution.restrictedReason).toBe(PROPOSAL_REFUSALS.notYoursToSchedule);
  });

  it("gives a PLATFORM administrator the live floor, because the arming path honours one", async () => {
    const access = {
      actor: { userId: "platform-admin" } as never,
      roles: { platformRole: "platform_admin", actorOrganizationId: ORG_ID } as never,
    };

    const resolution = await resolveProposalForRun(
      RUN_ID,
      { userId: "platform-admin", orgId: ORG_ID },
      access,
    );

    expect(resolution.phase).toBe("run_pending");
    if (resolution.phase !== "run_pending") return;
    expect(resolution.canConfirm).toBe(true);
    expect(resolution.restrictedReason).toBeNull();
  });

  it("answers a reader the run's access control refuses with nothing at all, and leaks nothing", async () => {
    const { AuthzError } = await import("@/lib/authz");
    store.readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden" }),
    );

    const resolution = await resolveProposalForRun(
      RUN_ID,
      { userId: "stranger", orgId: ORG_ID },
      { actor: { userId: "stranger" } as never },
    );

    // The WHOLE answer, and it carries no agent name, no run id, no phase copy.
    expect(resolution).toEqual({ phase: "absent" });
    expect(Object.keys(resolution)).toEqual(["phase"]);
  });

  it("answers nothing for a template that has vanished, and for one of another organization", async () => {
    store.readAgentTemplateById.mockResolvedValue(null);
    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({ phase: "absent" });

    store.readAgentTemplateById.mockResolvedValue({
      id: TEMPLATE_ID,
      name: "Weekly cohort sweep",
      packageName: "weekly-cohort-sweep",
      orgId: "org-somebody-else",
    });
    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({ phase: "absent" });
  });

  it("answers nothing for a run that has vanished", async () => {
    store.readAgentRunById.mockResolvedValue(null);
    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({ phase: "absent" });
  });
});

// ---------------------------------------------------------------------------
// The arming entry — the FIRST answer, given once, to a run that is still asking
// (a convergence round's findings 2, 3 and 5)
// ---------------------------------------------------------------------------

describe("armRunScheduleForActor", () => {
  const owner = { userId: OWNER_ID, role: null, source: "ui" as const };
  const SCHEDULED = {
    kind: "scheduled" as const,
    runAt: "2030-01-01T09:00",
    timezone: "Europe/Berlin",
  };

  it("arms the waiting run through the ONE trigger path", async () => {
    const result = await armRunScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: SCHEDULED,
    });

    expect(result).toEqual({ ok: true, runId: RUN_ID, alreadyArmed: false });
    expect(triggerStore.createOrUpdateRunTrigger).toHaveBeenCalled();
    expect(schedule.scheduleTrigger).toHaveBeenCalledTimes(1);
    // Through the run's own legal edge, not a second ladder.
    expect(store.transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "pending_input",
      "armed",
      undefined,
      expect.anything(),
    );
  });

  it("answers a SECOND press with the first press's answer, and writes nothing", async () => {
    // The first press landed: the run now has a trigger row. The answer is taken
    // on the CLAIMED read — there is no snapshot outside the claim to be wrong
    // about a preliminary row the first press may still roll back.
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      runId: RUN_ID,
      triggerType: "scheduled",
      scheduledAt: new Date("2030-01-01T09:00:00Z"),
      cronExpression: null,
      timezone: "Europe/Berlin",
      enabled: true,
      releasedAt: null,
      lastFiredAt: null,
      stoppedAt: null,
    });

    const result = await armRunScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: { kind: "recurring", selection: RECURRING_SELECTION, timezone: "UTC" },
    });

    // The same true answer, and the schedule the first press set is untouched.
    expect(result).toEqual({ ok: true, runId: RUN_ID, alreadyArmed: true });
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
  });

  it("answers the SERIALIZED second press the same way — the claim decides, not the snapshot", async () => {
    // The row appears only INSIDE the claim: the other press arrived between
    // this call's snapshot and its write, which is the window the snapshot alone
    // cannot see. The claim's own read is what the setter acts on.
    let armedByTheOtherPress = false;
    triggerStore.readRunTriggerByRunId.mockImplementation(async () =>
      armedByTheOtherPress
        ? {
            runId: RUN_ID,
            triggerType: "scheduled",
            scheduledAt: new Date("2030-01-01T09:00:00Z"),
            cronExpression: null,
            timezone: "Europe/Berlin",
            enabled: true,
            releasedAt: null,
            lastFiredAt: null,
            stoppedAt: null,
          }
        : null,
    );
    claim.withTriggerClaim.mockImplementation(
      async (runId: string, body: (live: unknown) => Promise<unknown>) => {
        armedByTheOtherPress = true;
        return body(await triggerStore.readRunTriggerByRunId(runId));
      },
    );

    const result = await armRunScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: SCHEDULED,
    });

    expect(result).toEqual({ ok: true, runId: RUN_ID, alreadyArmed: true });
    // NOTHING WAS REPLACED: the other press's scheduler is still the live one.
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
  });

  it("REFUSES a run stopped INSIDE the claim window — the boundary, not the courtesy read", async () => {
    // The cheap read at the top saw a waiting run; the Stop lands after it. Only
    // the re-ask on the claimed read can see that, and without it the scheduled
    // request sails past the setter's terminal gate — which applies to
    // `immediate` alone — and installs a live scheduler on a run that is over.
    let stopped = false;
    store.readAgentRunById.mockImplementation(async () =>
      stopped ? { ...WAITING_RUN, status: "stopped" } : WAITING_RUN,
    );
    claim.withTriggerClaim.mockImplementation(
      async (runId: string, body: (live: unknown) => Promise<unknown>) => {
        stopped = true;
        return body(await triggerStore.readRunTriggerByRunId(runId));
      },
    );

    const result = await armRunScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: SCHEDULED,
    });

    expect(result).toEqual({ ok: false, error: ARM_SCHEDULE_REFUSALS.movedOn });
    // NOTHING WAS WRITTEN: no trigger row, no scheduler, no status flip.
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("REFUSES when the run cannot be re-read inside the claim — not arming is the recoverable half", async () => {
    let inClaim = false;
    store.readAgentRunById.mockImplementation(async () => {
      if (inClaim) throw new Error("the store could not answer");
      return WAITING_RUN;
    });
    claim.withTriggerClaim.mockImplementation(
      async (runId: string, body: (live: unknown) => Promise<unknown>) => {
        inClaim = true;
        return body(await triggerStore.readRunTriggerByRunId(runId));
      },
    );

    const result = await armRunScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: SCHEDULED,
    });

    expect(result).toEqual({ ok: false, error: ARM_SCHEDULE_REFUSALS.movedOn });
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
  });

  it("REFUSES a run that has already moved on before any write", async () => {
    // A Stop landed between the card being drawn and the press. Without this the
    // scheduled request would sail past the setter's terminal gate — which
    // applies to `immediate` alone — and install a live scheduler on a run that
    // is over.
    store.readAgentRunById.mockResolvedValue({ ...WAITING_RUN, status: "stopped" });

    const result = await armRunScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: SCHEDULED,
    });

    expect(result).toEqual({ ok: false, error: ARM_SCHEDULE_REFUSALS.movedOn });
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("refuses a caller who is neither the run's owner nor an administrator", async () => {
    const result = await armRunScheduleForActor(
      { userId: "somebody-else", role: null, source: "ui" },
      { runId: RUN_ID, schedule: SCHEDULED },
    );

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
  });
});

describe("the settled road is unchanged", () => {
  it("still answers SETTLED once the waiting run's schedule is armed", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      runId: RUN_ID,
      triggerType: "scheduled",
      scheduledAt: new Date("2030-01-01T09:00:00Z"),
      cronExpression: null,
      timezone: "Europe/Berlin",
      enabled: true,
      releasedAt: null,
      lastFiredAt: null,
      stoppedAt: null,
    });
    store.readAgentRunById.mockResolvedValue({ ...WAITING_RUN, status: "armed" });

    const resolution = await resolveProposalForRun(RUN_ID, READER);

    expect(resolution.phase).toBe("settled");
    if (resolution.phase !== "settled") return;
    expect(resolution.triggerType).toBe("scheduled");
    expect(resolution.runId).toBe(RUN_ID);
  });
});
