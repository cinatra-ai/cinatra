/**
 * A FIRE THAT RELEASED NOTHING ENQUEUES NOTHING (cinatra#2928 review, blocker 1).
 *
 * WHAT WENT WRONG. The one-off fire's `armed → queued` release moved onto
 * `advanceAgentRun` without saying what to do with a LOST race, and the default
 * is to ANSWER: the coordinator re-reads the row and returns normally. The
 * handler below it still branched on `RunTransitionError` — which could no
 * longer arrive — so the guard that used to skip the execution enqueue for a run
 * that was never released had become unreachable code.
 *
 * The case it was guarding is a person cancelling a scheduled run to `stopped`
 * before its instant arrives. The job then enqueued an execution for a run it
 * did not release, and cleared the moment off a row another writer owns.
 *
 * WHAT DECIDES NOW. The release asks the coordinator to THROW on a lost race, and
 * this job re-reads the row to tell the two losers apart: a run that reads
 * `queued` was released by an earlier fire whose enqueue did not stick, and the
 * retry re-enqueues it; anything else was not released by this fire, and it
 * enqueues nothing and clears nothing.
 *
 * The run row is SIMULATED rather than asserted call-by-call: the CAS, the
 * moment guards and the concurrent cancel all act on one mutable row, so each
 * test states an outcome about the run instead of about the mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2928-lost-race";
const ORG_ID = "org-2928";

const { StubRunTransitionError } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
}));

type Row = {
  id: string;
  templateId: string;
  runBy: string | null;
  orgId: string;
  status: string;
  lifecycleMoment: string | null;
  lifecycleCardKind: string | null;
  lifecycleCardRef: string | null;
};

let row: Row | null = null;

const store = vi.hoisted(() => ({
  RunTransitionError: null as unknown,
  readAgentRunById: vi.fn(),
  transitionRunStatus: vi.fn(),
  recordRunLifecycleMoment: vi.fn(),
  createAgentRunPendingInput: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
}));
store.RunTransitionError = StubRunTransitionError;

const trigger = vi.hoisted(() => ({
  readRunTriggerByRunId: vi.fn(),
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
const gate = vi.hoisted(() => ({ markTriggerReleased: vi.fn(async () => undefined) }));
const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));

vi.mock("../store", () => store);
vi.mock("../trigger-store", () => trigger);
vi.mock("../trigger-gate", () => gate);
vi.mock("@/lib/agent-run-enqueue", () => enqueue);
vi.mock("../pm-link-store", () => ({ deletePmLinkByRunId: vi.fn(async () => undefined) }));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
vi.mock("@/lib/background-jobs", () => ({
  ensureBackgroundJobRuntime: vi.fn(async () => ({
    queue: { removeJobScheduler: vi.fn(async () => undefined) },
  })),
  BACKGROUND_JOB_NAMES: {
    AGENT_BUILDER_EXECUTION: "agent-builder-execution",
    AGENT_RUN_TRIGGER_RELEASE: "agent-run-trigger-release",
  },
}));
vi.mock("@/lib/pm-integration-providers", () => ({
  readRunTriggerPmState: vi.fn(async () => ({ kind: "no-provider" })),
}));
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintTriggerReleaseAuthority: vi.fn(() => ({ kind: "system" })),
}));
vi.mock("@/lib/org-write/dispatch-freeze", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => false),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));

function armedRunAtItsSchedule(): Row {
  return {
    id: RUN_ID,
    templateId: "tmpl-2928",
    runBy: "user-2928",
    orgId: ORG_ID,
    status: "armed",
    lifecycleMoment: "schedule",
    lifecycleCardKind: "agent_schedule_step",
    lifecycleCardRef: "trigger-2928",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.enqueueAgentRun.mockResolvedValue(undefined);
  row = armedRunAtItsSchedule();

  store.readAgentRunById.mockImplementation(async (id: string) =>
    row && row.id === id ? { ...row } : null,
  );
  // The real CAS: it moves the row only from the status the caller named.
  store.transitionRunStatus.mockImplementation(
    async (id: string, from: string, to: string) => {
      if (!row || row.id !== id) throw new StubRunTransitionError("stale_from_status");
      if (row.status !== from) throw new StubRunTransitionError("stale_from_status");
      row.status = to;
    },
  );
  // The real guarded moment write, including both of its pins.
  store.recordRunLifecycleMoment.mockImplementation(
    async (input: {
      runId: string;
      moment: string | null;
      cardKind?: string | null;
      cardRef?: string | null;
      onlyWhileStatus?: string;
      onlyWhileMoment?: string | null;
    }) => {
      if (!row || row.id !== input.runId) return;
      if (input.onlyWhileStatus !== undefined && row.status !== input.onlyWhileStatus) return;
      if (input.onlyWhileMoment !== undefined && row.lifecycleMoment !== input.onlyWhileMoment) {
        return;
      }
      row.lifecycleMoment = input.moment;
      row.lifecycleCardKind = input.cardKind ?? null;
      row.lifecycleCardRef = input.cardRef ?? null;
    },
  );
  trigger.readRunTriggerByRunId.mockResolvedValue({
    runId: RUN_ID,
    triggerType: "scheduled",
    enabled: true,
    timezone: "UTC",
    scheduledAt: new Date("2026-09-01T09:00:00.000Z"),
    cronExpression: null,
    jobSchedulerId: `trigger-release-${RUN_ID}`,
  });
});

async function fire() {
  const { runAgentRunTriggerReleaseJob } = await import("../trigger-release-job");
  await runAgentRunTriggerReleaseJob({ runId: RUN_ID }, "job-2928");
}

describe("the one-off fire and a lost armed → queued race", () => {
  it("a run CANCELLED before its instant gets no execution job, and keeps its moment", async () => {
    // The person stops the run in the window between this job reading the row
    // and its release CAS — the case the deleted guard existed for.
    store.transitionRunStatus.mockImplementationOnce(async () => {
      if (row) row.status = "stopped";
      throw new StubRunTransitionError("stale_from_status");
    });

    await fire();

    // NO EXECUTION JOB. The fire released nothing, so it dispatches nothing.
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
    // THE MOMENT IS INTACT. It belongs to the writer that owns the run now.
    expect(row?.lifecycleMoment).toBe("schedule");
    expect(row?.lifecycleCardRef).toBe("trigger-2928");
    expect(store.recordRunLifecycleMoment).not.toHaveBeenCalled();
    // AND THE RUN IS STILL STOPPED — this job wrote no status of its own after
    // losing, so it neither revived the run nor failed it.
    expect(row?.status).toBe("stopped");
  });

  it("a run NEVER ARMED is left exactly as it is", async () => {
    // The other loser the old guard named: an immediate trigger that fired
    // without going through pending_input → armed.
    if (row) {
      row.status = "pending_input";
      row.lifecycleMoment = null;
      row.lifecycleCardKind = null;
      row.lifecycleCardRef = null;
    }

    await fire();

    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
    expect(row?.status).toBe("pending_input");
    expect(store.recordRunLifecycleMoment).not.toHaveBeenCalled();
  });

  it("a BullMQ RETRY of a run already released re-enqueues its execution", async () => {
    // The reason the release cannot simply refuse a lost race: the first fire
    // won the CAS and its enqueue did not stick, so the row is `queued` with no
    // job behind it — the one state nothing recovers from on its own.
    if (row) {
      row.status = "queued";
      row.lifecycleMoment = null;
      row.lifecycleCardKind = null;
      row.lifecycleCardRef = null;
    }

    await fire();

    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(enqueue.enqueueAgentRun.mock.calls[0][0]).toEqual({ runId: RUN_ID });
    expect(enqueue.enqueueAgentRun.mock.calls[0][1]).toEqual({
      jobId: `agent-builder-${RUN_ID}`,
    });
    expect(row?.status).toBe("queued");
  });

  it("the ordinary fire still releases, enqueues and clears the moment", async () => {
    await fire();

    expect(row?.status).toBe("queued");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
    // The schedule moment is over, and all three columns go with it.
    expect(row?.lifecycleMoment).toBeNull();
    expect(row?.lifecycleCardKind).toBeNull();
    expect(row?.lifecycleCardRef).toBeNull();
  });
});
